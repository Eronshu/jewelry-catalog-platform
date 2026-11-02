import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPayPalSandboxRefund,
  retrievePayPalSandboxRefund,
  type PayPalSandboxRefundAssociation,
} from "./paypal-refund-sandbox.server";
import {
  type PayPalSandboxConfig,
  type PayPalSandboxFetch,
} from "./paypal-sandbox.server";
const c: PayPalSandboxConfig = {
  enabled: true,
  mode: "local-test",
  instanceId: "11111111-1111-4111-8111-111111111111",
  expectedMerchantId: "2".repeat(13),
  clientId: "0".repeat(24),
  clientSecret: "1".repeat(24),
  canonicalOrigin: "http://127.0.0.1:8791",
};
const a: PayPalSandboxRefundAssociation = {
  orderId: "order-22222222-2222-4222-8222-222222222222",
  attemptId: "33333333-3333-4333-8333-333333333333",
  createOperationKey: "44444444-4444-4444-8444-444444444444",
  providerOrderId: "ORDER2222",
  captureId: "CAPTURE3333",
  amountCents: 4005,
  refundOperationKey: "55555555-5555-4555-8555-555555555555",
};
function fixture() {
  const amount = { currency_code: "CAD", value: "40.05" };
  const summary: Record<string, unknown> = {
    id: a.captureId,
    final_capture: true,
    status: "COMPLETED",
    amount,
  };
  const capture: Record<string, unknown> = {
    ...summary,
    payee: { merchant_id: c.expectedMerchantId },
    supplementary_data: { related_ids: { order_id: a.providerOrderId } },
    custom_id: `local-test:${c.instanceId}:${a.attemptId}:${a.createOperationKey}`,
  };
  const unit: Record<string, unknown> = {
    reference_id: a.orderId,
    custom_id: capture.custom_id,
    payee: { merchant_id: c.expectedMerchantId },
    amount,
    payments: { captures: [summary], refunds: [] },
  };
  const order: Record<string, unknown> = {
    id: a.providerOrderId,
    intent: "CAPTURE",
    status: "COMPLETED",
    purchase_units: [unit],
  };
  const refund: Record<string, unknown> = {
    id: "REFUND4444",
    status: "PENDING",
    amount,
    custom_id: `refund-${c.instanceId}-${a.refundOperationKey}`,
    links: [
      {
        rel: "up",
        method: "GET",
        href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${a.captureId}`,
      },
    ],
  };
  const oauth: Record<string, unknown> = {
    token_type: "Bearer",
    expires_in: 3600,
    access_token: "2".repeat(24),
  };
  const call = vi.fn<PayPalSandboxFetch>(async (url, init) => {
    expect(new URL(url).origin).toBe("https://api-m.sandbox.paypal.com");
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const path = new URL(url).pathname;
    if (path === "/v1/oauth2/token") return Response.json(oauth);
    if (path === `/v2/checkout/orders/${a.providerOrderId}`)
      return Response.json(order);
    if (path === `/v2/payments/captures/${a.captureId}`)
      return Response.json(capture);
    if (path === `/v2/payments/captures/${a.captureId}/refund`)
      return Response.json(refund);
    if (path === "/v2/payments/refunds/REFUND4444")
      return Response.json(refund);
    throw new Error("Unexpected fixture path");
  });
  return { order, unit, summary, capture, refund, oauth, call };
}
function complete(p: ReturnType<typeof fixture>) {
  p.refund.status = "COMPLETED";
  p.capture.status = "REFUNDED";
  p.summary.status = "REFUNDED";
}
function financialPosts(p: ReturnType<typeof fixture>) {
  return p.call.mock.calls.filter(
    ([url, init]) =>
      init.method === "POST" && !url.endsWith("/v1/oauth2/token"),
  );
}
afterEach(() => {
  vi.useRealTimers();
});
describe("isolated full PayPal Sandbox refund adapter", () => {
  it("binds exact full CAD amount/custom association/original key and checks authority after all provider waits", async () => {
    const p = fixture();
    const guard = vi.fn(async () => {
      expect(p.call).toHaveBeenCalledTimes(3);
    });
    expect(await createPayPalSandboxRefund(c, a, p.call, guard)).toEqual({
      refundId: "REFUND4444",
    });
    expect(guard).toHaveBeenCalledOnce();
    const [url, init] = financialPosts(p)[0];
    expect(url).toBe(
      `https://api-m.sandbox.paypal.com/v2/payments/captures/${a.captureId}/refund`,
    );
    expect(new Headers(init.headers).get("PayPal-Request-Id")).toBe(
      a.refundOperationKey,
    );
    expect(new Headers(init.headers).get("Prefer")).toBe(
      "return=representation",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      amount: { currency_code: "CAD", value: "40.05" },
      custom_id: `refund-${c.instanceId}-${a.refundOperationKey}`,
    });
  });
  it("does not interpret POST COMPLETED acknowledgment as refund success", async () => {
    const p = fixture();
    p.refund.status = "COMPLETED";
    expect(await createPayPalSandboxRefund(c, a, p.call)).toEqual({
      refundId: "REFUND4444",
    });
    await expect(
      retrievePayPalSandboxRefund(c, a, p.call, "REFUND4444"),
    ).rejects.toMatchObject({ code: "reconcile_required" });
    complete(p);
    expect(
      await retrievePayPalSandboxRefund(c, a, p.call, "REFUND4444"),
    ).toEqual({
      refundId: "REFUND4444",
      status: "succeeded",
      amountCents: 4005,
      refundedCents: 4005,
    });
    expect(financialPosts(p)).toHaveLength(1);
  });
  it.each([
    ["PENDING", "pending"],
    ["FAILED", "failed"],
    ["CANCELLED", "canceled"],
  ])(
    "projects %s only after canonical association checks",
    async (providerState, state) => {
      const p = fixture();
      p.refund.status = providerState;
      expect(
        await retrievePayPalSandboxRefund(c, a, p.call, "REFUND4444"),
      ).toMatchObject({ status: state, refundedCents: 0 });
      expect(financialPosts(p)).toHaveLength(0);
    },
  );
  it("recovers lost ID only from exact bounded original Order association", async () => {
    const p = fixture();
    complete(p);
    (p.unit.payments as { refunds: unknown[] }).refunds = [p.refund];
    expect(await retrievePayPalSandboxRefund(c, a, p.call)).toMatchObject({
      status: "succeeded",
    });
    expect(financialPosts(p)).toHaveLength(0);
    expect(p.call.mock.calls.at(-1)![0]).toBe(
      "https://api-m.sandbox.paypal.com/v2/payments/refunds/REFUND4444",
    );
  });
  it("returns null for absent or untrusted lost ID without financial retry", async () => {
    const p = fixture();
    expect(await retrievePayPalSandboxRefund(c, a, p.call)).toBeNull();
    (p.unit.payments as { refunds: unknown[] }).refunds = [
      { ...p.refund, custom_id: "other" },
    ];
    expect(await retrievePayPalSandboxRefund(c, a, p.call)).toBeNull();
    expect(financialPosts(p)).toHaveLength(0);
  });
  it("rejects duplicate, excessive or external refund candidates", async () => {
    const p = fixture(),
      payments = p.unit.payments as { refunds: unknown[] };
    payments.refunds = [p.refund, p.refund];
    await expect(
      retrievePayPalSandboxRefund(c, a, p.call),
    ).rejects.toMatchObject({ code: "reconcile_required" });
    payments.refunds = Array.from({ length: 101 }, () => p.refund);
    await expect(
      retrievePayPalSandboxRefund(c, a, p.call),
    ).rejects.toMatchObject({ code: "invalid_response" });
    payments.refunds = [{ ...p.refund, id: "OTHER5555" }];
    await expect(
      retrievePayPalSandboxRefund(c, a, p.call, "REFUND4444"),
    ).rejects.toMatchObject({ code: "reconcile_required" });
    expect(financialPosts(p)).toHaveLength(0);
  });
  it.each([
    ["order", "id", "OTHER5555"],
    ["order", "status", "APPROVED"],
    ["order", "intent", "AUTHORIZE"],
    ["unit", "reference_id", "order-other"],
    ["unit", "custom_id", "other"],
    ["unit", "payee", { merchant_id: "3".repeat(13) }],
    ["unit", "amount", { currency_code: "USD", value: "40.05" }],
    ["unit", "amount", { currency_code: "CAD", value: "0.01" }],
    ["capture", "id", "OTHER5555"],
    ["capture", "final_capture", false],
    ["capture", "status", "PARTIALLY_REFUNDED"],
    ["capture", "amount", { currency_code: "CAD", value: "40.04" }],
    ["capture", "custom_id", "wrong"],
    ["capture", "payee", { merchant_id: "3".repeat(13) }],
    [
      "capture",
      "supplementary_data",
      { related_ids: { order_id: "OTHER5555" } },
    ],
    ["summary", "final_capture", false],
  ] as const)(
    "rejects mismatched %s.%s before financial POST",
    async (record, key, bad) => {
      const p = fixture();
      p[record][key] = bad;
      await expect(
        createPayPalSandboxRefund(c, a, p.call),
      ).rejects.toBeInstanceOf(Error);
      expect(financialPosts(p)).toHaveLength(0);
    },
  );
  it("refuses another refund or already-refunded capture before POST", async () => {
    const p = fixture();
    (p.unit.payments as { refunds: unknown[] }).refunds = [p.refund];
    await expect(createPayPalSandboxRefund(c, a, p.call)).rejects.toMatchObject(
      { code: "reconcile_required" },
    );
    (p.unit.payments as { refunds: unknown[] }).refunds = [];
    p.capture.status = "REFUNDED";
    await expect(createPayPalSandboxRefund(c, a, p.call)).rejects.toMatchObject(
      { code: "reconcile_required" },
    );
    expect(financialPosts(p)).toHaveLength(0);
  });
  it.each([
    ["id", "OTHER5555"],
    ["custom_id", "unrelated"],
    ["status", "SUCCEEDED"],
    ["amount", { currency_code: "CAD", value: "1.00" }],
    ["amount", { currency_code: "USD", value: "40.05" }],
    ["payer", { merchant_id: "3".repeat(13) }],
    [
      "seller_payable_breakdown",
      { total_refunded_amount: { currency_code: "CAD", value: "1.00" } },
    ],
  ] as const)("rejects canonical refund %s mismatch", async (key, bad) => {
    const p = fixture();
    complete(p);
    p.refund[key] = bad;
    await expect(
      retrievePayPalSandboxRefund(c, a, p.call, "REFUND4444"),
    ).rejects.toBeInstanceOf(Error);
    expect(financialPosts(p)).toHaveLength(0);
  });
  it.each([
    "https://api-m.paypal.com/v2/payments/captures/CAPTURE3333",
    "https://attacker.invalid/v2/payments/captures/CAPTURE3333",
    "https://api-m.sandbox.paypal.com/v2/payments/captures/OTHER5555",
    "https://api-m.sandbox.paypal.com/v2/payments/captures/CAPTURE3333?q=1",
    "https://api-m.sandbox.paypal.com/v2/payments/captures/CAPTURE3333#x",
    "https://name:pass@api-m.sandbox.paypal.com/v2/payments/captures/CAPTURE3333",
  ])(
    "rejects untrusted capture up link without following it: %s",
    async (href) => {
      const p = fixture();
      complete(p);
      p.refund.links = [{ rel: "up", method: "GET", href }];
      await expect(
        retrievePayPalSandboxRefund(c, a, p.call, "REFUND4444"),
      ).rejects.toMatchObject({ code: "invalid_response" });
      expect(p.call).toHaveBeenCalledTimes(4);
    },
  );
  it("supports only the official sandbox alias capture link and validates total evidence", async () => {
    const p = fixture();
    complete(p);
    p.refund.links = [
      {
        rel: "up",
        method: "GET",
        href: `https://api.sandbox.paypal.com/v2/payments/captures/${a.captureId}`,
      },
    ];
    p.refund.seller_payable_breakdown = {
      gross_amount: { currency_code: "CAD", value: "40.05" },
      total_refunded_amount: { currency_code: "CAD", value: "40.05" },
    };
    expect(
      await retrievePayPalSandboxRefund(c, a, p.call, "REFUND4444"),
    ).toMatchObject({ status: "succeeded" });
  });
  it("denied final authority after OAuth/order/capture waits prevents financial POST", async () => {
    const p = fixture();
    await expect(
      createPayPalSandboxRefund(c, a, p.call, async () => {
        expect(p.call).toHaveBeenCalledTimes(3);
        throw new Error("Authority expired");
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(financialPosts(p)).toHaveLength(0);
  });
  it("financial transport failure is unknown, includes original key and never retries", async () => {
    const p = fixture();
    const base = p.call.getMockImplementation()!;
    p.call.mockImplementation(async (url, init) => {
      if (url.endsWith("/refund")) throw new Error("Lost response");
      return base(url, init);
    });
    await expect(createPayPalSandboxRefund(c, a, p.call)).rejects.toMatchObject(
      { code: "unknown_outcome", operationKey: a.refundOperationKey },
    );
    expect(financialPosts(p)).toHaveLength(1);
  });
  it.each([302, 401, 500])(
    "rejects OAuth HTTP %s without following or mutating",
    async (status) => {
      const p = fixture();
      p.call.mockResolvedValue(
        new Response("", {
          status,
          headers: { Location: "https://attacker.invalid" },
        }),
      );
      await expect(
        createPayPalSandboxRefund(c, a, p.call),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(p.call).toHaveBeenCalledOnce();
      expect(financialPosts(p)).toHaveLength(0);
    },
  );
  it("rejects redirected OAuth, malformed token and oversized response", async () => {
    const p = fixture();
    const redirected = Response.json(p.oauth);
    Object.defineProperty(redirected, "redirected", { value: true });
    p.call.mockResolvedValueOnce(redirected);
    await expect(createPayPalSandboxRefund(c, a, p.call)).rejects.toMatchObject(
      { code: "unavailable" },
    );
    p.oauth.token_type = "basic";
    await expect(createPayPalSandboxRefund(c, a, p.call)).rejects.toMatchObject(
      { code: "invalid_response" },
    );
    p.call.mockResolvedValueOnce(
      Response.json({ data: "0".repeat(128 * 1024) }),
    );
    await expect(createPayPalSandboxRefund(c, a, p.call)).rejects.toMatchObject(
      { code: "invalid_response" },
    );
  });
  it("times out stalled OAuth without retry even when transport ignores abort", async () => {
    vi.useFakeTimers();
    const p = fixture();
    p.call.mockImplementation(() => new Promise(() => {}));
    const check = expect(
      createPayPalSandboxRefund(c, a, p.call),
    ).rejects.toMatchObject({ code: "unavailable" });
    await vi.advanceTimersByTimeAsync(10_001);
    await check;
    expect(p.call).toHaveBeenCalledOnce();
  });
  it("times out stalled financial POST as unknown, never retries", async () => {
    vi.useFakeTimers();
    const p = fixture(),
      base = p.call.getMockImplementation()!;
    p.call.mockImplementation((url, init) =>
      url.endsWith("/refund") ? new Promise(() => {}) : base(url, init),
    );
    const check = expect(
      createPayPalSandboxRefund(c, a, p.call),
    ).rejects.toMatchObject({
      code: "unknown_outcome",
      operationKey: a.refundOperationKey,
    });
    await vi.advanceTimersByTimeAsync(10_001);
    await check;
    expect(financialPosts(p)).toHaveLength(1);
  });
  it("rejects accessor/extras/unsafe configuration and keys without evaluating getters or networking", async () => {
    const p = fixture(),
      getter = vi.fn(() => a.amountCents);
    await expect(
      createPayPalSandboxRefund(
        c,
        {
          ...a,
          get amountCents() {
            return getter();
          },
        },
        p.call,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      createPayPalSandboxRefund({ ...c, mode: "live" }, a, p.call),
    ).rejects.toMatchObject({ code: "invalid_config" });
    await expect(
      createPayPalSandboxRefund(
        c,
        { ...a, refundOperationKey: a.createOperationKey },
        p.call,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      createPayPalSandboxRefund(c, { ...a, note: "extra" }, p.call),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      retrievePayPalSandboxRefund(c, a, p.call, "../wrong"),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(getter).not.toHaveBeenCalled();
    expect(p.call).not.toHaveBeenCalled();
  });
});
