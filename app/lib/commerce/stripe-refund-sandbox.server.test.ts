import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStripeSandboxRefund,
  retrieveStripeSandboxRefund,
  type StripeSandboxRefundAssociation,
} from "./stripe-refund-sandbox.server";
import {
  STRIPE_SANDBOX_API_VERSION,
  type StripeSandboxConfig,
  type StripeSandboxFetch,
} from "./stripe-sandbox.server";
const c: StripeSandboxConfig = {
  enabled: true,
  mode: "local-test",
  instanceId: "11111111-1111-4111-8111-111111111111",
  expectedAccountId: "acct_FictionalOnly123",
  testSecretKey: ["sk", "test", "0".repeat(24)].join("_"),
  canonicalOrigin: "http://127.0.0.1:8791",
};
const a: StripeSandboxRefundAssociation = {
  orderId: "order-22222222-2222-4222-8222-222222222222",
  paymentRequestId: "33333333-3333-4333-8333-333333333333",
  createOperationKey: "44444444-4444-4444-8444-444444444444",
  requestId: "55555555-5555-4555-8555-555555555555",
  operationKey: "55555555-5555-4555-8555-555555555555",
  captureId: "a".repeat(64),
  chargeId: "ch_FictionalOnly123",
  paymentIntentId: "pi_FictionalOnly123",
  amountCents: 4005,
};
function fixture() {
  const metadata = {
    test_mode: "local-test",
    instance_id: c.instanceId,
    account_ref: c.expectedAccountId,
    order_id: a.orderId,
    attempt_id: a.paymentRequestId,
    create_operation_key: a.createOperationKey,
  };
  const account: Record<string, unknown> = {
    object: "account",
    id: c.expectedAccountId,
  };
  const pi: Record<string, unknown> = {
    object: "payment_intent",
    id: a.paymentIntentId,
    livemode: false,
    status: "succeeded",
    currency: "cad",
    amount: a.amountCents,
    amount_received: a.amountCents,
    amount_capturable: 0,
    latest_charge: a.chargeId,
    metadata,
  };
  const ch: Record<string, unknown> = {
    object: "charge",
    id: a.chargeId,
    payment_intent: a.paymentIntentId,
    livemode: false,
    status: "succeeded",
    paid: true,
    captured: true,
    currency: "cad",
    amount: a.amountCents,
    amount_captured: a.amountCents,
    amount_refunded: 0,
    refunded: false,
    disputed: false,
  };
  const refund: Record<string, unknown> = {
    object: "refund",
    id: "re_FictionalOnly123",
    charge: a.chargeId,
    payment_intent: a.paymentIntentId,
    currency: "cad",
    amount: a.amountCents,
    status: "pending",
    metadata: {
      ...metadata,
      refund_request_id: a.requestId,
      refund_operation_key: a.operationKey,
      capture_id: a.captureId,
    },
  };
  const list = { object: "list", data: [refund], has_more: false };
  const call = vi.fn<StripeSandboxFetch>(async (url, init) => {
    expect(new URL(url).origin).toBe("https://api.stripe.com");
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init.headers).get("Stripe-Version")).toBe(
      STRIPE_SANDBOX_API_VERSION,
    );
    const path = new URL(url).pathname;
    if (path === "/v1/account") return Response.json(account);
    if (path.startsWith("/v1/payment_intents/")) return Response.json(pi);
    if (path.startsWith("/v1/charges/")) return Response.json(ch);
    if (path === "/v1/refunds" && init.method === "POST")
      return Response.json(refund);
    if (path === "/v1/refunds") return Response.json(list);
    if (path.startsWith("/v1/refunds/")) return Response.json(refund);
    throw new Error("Unexpected fixture path");
  });
  return { account, pi, ch, refund, list, call };
}
afterEach(() => vi.useRealTimers());
describe("strict injected Stripe Sandbox refund adapter", () => {
  it("uses original charge/full cents/key/metadata and runs guard after canonical reads", async () => {
    const p = fixture(),
      hook = vi.fn(async () => {
        expect(p.call).toHaveBeenCalledTimes(3);
      });
    expect(await createStripeSandboxRefund(c, a, p.call, hook)).toBe(
      "re_FictionalOnly123",
    );
    expect(hook).toHaveBeenCalledOnce();
    const [, init] = p.call.mock.calls.at(-1)!;
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe(
      a.operationKey,
    );
    const body = new URLSearchParams(init.body as string);
    expect(body.get("amount")).toBe("4005");
    expect(body.get("charge")).toBe(a.chargeId);
    expect(body.get("metadata[refund_request_id]")).toBe(a.requestId);
  });
  it("POST status alone is only an ID and fresh reads verify success without requiring nonexistent refund livemode", async () => {
    const p = fixture();
    p.refund.status = "succeeded";
    expect(await createStripeSandboxRefund(c, a, p.call, async () => {})).toBe(
      "re_FictionalOnly123",
    );
    await expect(
      retrieveStripeSandboxRefund(c, a, p.call, "re_FictionalOnly123"),
    ).rejects.toMatchObject({ code: "invalid_response" });
    p.ch.amount_refunded = a.amountCents;
    p.ch.refunded = true;
    expect(
      await retrieveStripeSandboxRefund(c, a, p.call, "re_FictionalOnly123"),
    ).toMatchObject({ status: "succeeded", refundedCents: 4005 });
  });
  it("recovers a lost ID using only bounded GET list then exact refund GET", async () => {
    const p = fixture();
    expect(await retrieveStripeSandboxRefund(c, a, p.call)).toMatchObject({
      status: "pending",
    });
    expect(p.call.mock.calls.every(([, i]) => i.method === "GET")).toBe(true);
    expect(
      p.call.mock.calls.some(([url]) =>
        url.includes("/v1/refunds?charge=ch_FictionalOnly123&limit=100"),
      ),
    ).toBe(true);
  });
  it("rejects incomplete and ambiguous bounded lists", async () => {
    const p = fixture();
    p.list.has_more = true;
    await expect(
      retrieveStripeSandboxRefund(c, a, p.call),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(
      p.call.mock.calls.filter(([url]) => url.includes("/v1/refunds?")).length,
    ).toBeLessThanOrEqual(3);
    p.list.has_more = false;
    p.list.data.push({ ...p.refund, id: "re_OtherFictional123" });
    await expect(
      retrieveStripeSandboxRefund(c, a, p.call),
    ).rejects.toMatchObject({ code: "reconcile_required" });
  });
  it.each([
    ["account", "id", "acct_OtherFictional123"],
    ["pi", "livemode", true],
    ["pi", "amount_received", 1],
    ["pi", "currency", "usd"],
    ["pi", "latest_charge", "ch_OtherFictional123"],
    ["pi", "metadata", {}],
    ["ch", "payment_intent", "pi_OtherFictional123"],
    ["ch", "amount_captured", 1],
    ["ch", "disputed", true],
    ["ch", "paid", false],
    ["ch", "livemode", true],
    ["refund", "currency", "usd"],
    ["refund", "amount", 1],
    ["refund", "charge", "ch_OtherFictional123"],
    ["refund", "payment_intent", "pi_OtherFictional123"],
    ["refund", "metadata", {}],
    ["refund", "livemode", true],
    ["refund", "status", "unknown"],
  ] as const)("rejects %s.%s mismatch", async (target, key, value) => {
    const p = fixture();
    p[target][key] = value;
    await expect(
      retrieveStripeSandboxRefund(c, a, p.call, "re_FictionalOnly123"),
    ).rejects.toMatchObject({
      code: target === "account" ? "account_mismatch" : "invalid_response",
    });
  });
  it("does not mutate if charge is already partly refunded or authorization expires after GET", async () => {
    const p = fixture();
    p.ch.amount_refunded = 1;
    await expect(
      createStripeSandboxRefund(c, a, p.call, async () => {}),
    ).rejects.toMatchObject({ code: "invalid_response" });
    p.ch.amount_refunded = 0;
    await expect(
      createStripeSandboxRefund(c, a, p.call, async () => {
        throw new Error("Synthetic revoked session");
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(p.call.mock.calls.every(([, i]) => i.method === "GET")).toBe(true);
  });
  it("sanitizes unknown POST responses and rejects redirect, oversized body and wrong content type", async () => {
    const p = fixture();
    const lose: StripeSandboxFetch = async (url, init) => {
      if (init.method === "POST")
        throw new Error("Synthetic private provider detail");
      return p.call(url, init);
    };
    await expect(
      createStripeSandboxRefund(c, a, lose, async () => {}),
    ).rejects.toMatchObject({
      code: "unknown_outcome",
      operationKey: a.operationKey,
      message: "Stripe test operation could not be verified",
    });
    for (const response of [
      new Response(null, {
        status: 302,
        headers: { Location: "https://other.example.test" },
      }),
      new Response("{}", { headers: { "Content-Type": "text/plain" } }),
      new Response("{}", {
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(128 * 1024 + 1),
        },
      }),
    ]) {
      await expect(
        retrieveStripeSandboxRefund(c, a, async () => response),
      ).rejects.toBeInstanceOf(Error);
    }
  });
  it("times out transport and streaming body even when injected transport ignores abort", async () => {
    vi.useFakeTimers();
    const pending = retrieveStripeSandboxRefund(
      c,
      a,
      async () => new Promise<Response>(() => {}),
    );
    const assertion = expect(pending).rejects.toMatchObject({
      code: "unavailable",
    });
    await vi.advanceTimersByTimeAsync(10001);
    await assertion;
    const body = retrieveStripeSandboxRefund(
      c,
      a,
      async () =>
        new Response(new ReadableStream({ start() {} }), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    const bodyAssertion = expect(body).rejects.toMatchObject({
      code: "unavailable",
    });
    await vi.advanceTimersByTimeAsync(10001);
    await bodyAssertion;
  });
  it("strict input/config descriptors never invoke accessors or accept live keys", async () => {
    const p = fixture(),
      getter = vi.fn(() => a.amountCents);
    await expect(
      retrieveStripeSandboxRefund(
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
    expect(getter).not.toHaveBeenCalled();
    await expect(
      retrieveStripeSandboxRefund(
        { ...c, testSecretKey: "sk_live_" + "0".repeat(24) },
        a,
        p.call,
      ),
    ).rejects.toMatchObject({ code: "invalid_config" });
    expect(p.call).not.toHaveBeenCalled();
  });
});
