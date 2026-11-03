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
function fixture(input: StripeSandboxRefundAssociation = a) {
  const a = input;
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
    amount_refunded: a.expectedRefundedCents ?? 0,
    refunded: a.expectedRefundedCents === a.amountCents,
    disputed: false,
  };
  const refund: Record<string, unknown> = {
    object: "refund",
    id: "re_FictionalOnly123",
    charge: a.chargeId,
    payment_intent: a.paymentIntentId,
    currency: "cad",
    amount: a.refundCents ?? a.amountCents,
    status: "pending",
    metadata: {
      ...metadata,
      refund_request_id: a.requestId,
      refund_operation_key: a.operationKey,
      capture_id: a.captureId,
      ...(a.refundCents === undefined
        ? {}
        : {
            refund_version: "2",
            refund_amount_cents: String(a.refundCents),
            refund_expected_refunded_cents: String(a.expectedRefundedCents),
          }),
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
  it("refunds a partial amount then the remainder under separate original request keys", async () => {
    const first = { ...a, refundCents: 1000, expectedRefundedCents: 0 };
    const remainder = {
      ...a,
      requestId: "66666666-6666-4666-8666-666666666666",
      operationKey: "66666666-6666-4666-8666-666666666666",
      refundCents: 3005,
      expectedRefundedCents: 1000,
    };
    const bodies: URLSearchParams[] = [];
    const keys: string[] = [];
    for (const input of [first, remainder]) {
      const p = fixture(input);
      const hook = vi.fn(async () => {
        expect(p.call).toHaveBeenCalledTimes(3);
      });
      expect(await createStripeSandboxRefund(c, input, p.call, hook)).toBe(
        "re_FictionalOnly123",
      );
      expect(hook).toHaveBeenCalledOnce();
      const [, post] = p.call.mock.calls.at(-1)!;
      bodies.push(new URLSearchParams(post.body as string));
      keys.push(new Headers(post.headers).get("Idempotency-Key")!);
      expect(await retrieveStripeSandboxRefund(c, input, p.call)).toEqual({
        refundId: "re_FictionalOnly123",
        status: "pending",
        amountCents: 4005,
        refundedCents: 0,
      });
      p.refund.status = "succeeded";
      p.ch.amount_refunded = input.expectedRefundedCents + input.refundCents;
      p.ch.refunded = p.ch.amount_refunded === input.amountCents;
      expect(
        await retrieveStripeSandboxRefund(
          c,
          input,
          p.call,
          "re_FictionalOnly123",
        ),
      ).toEqual({
        refundId: "re_FictionalOnly123",
        status: "succeeded",
        amountCents: 4005,
        refundedCents: input.refundCents,
      });
    }
    expect(keys).toEqual([first.operationKey, remainder.operationKey]);
    expect(bodies.map((body) => body.get("amount"))).toEqual(["1000", "3005"]);
    expect(bodies.map((body) => body.get("metadata[refund_version]"))).toEqual([
      "2",
      "2",
    ]);
    expect(
      bodies.map((body) => body.get("metadata[refund_amount_cents]")),
    ).toEqual(["1000", "3005"]);
    expect(
      bodies.map((body) =>
        body.get("metadata[refund_expected_refunded_cents]"),
      ),
    ).toEqual(["0", "1000"]);
  });
  it.each([
    { refundCents: 0, expectedRefundedCents: 0 },
    { refundCents: -1, expectedRefundedCents: 0 },
    { refundCents: 1.5, expectedRefundedCents: 0 },
    { refundCents: 4006, expectedRefundedCents: 0 },
    { refundCents: 1000, expectedRefundedCents: 3006 },
    { refundCents: 1000, expectedRefundedCents: -1 },
    { refundCents: 1000, expectedRefundedCents: 0.5 },
    { refundCents: Number.MAX_SAFE_INTEGER + 1, expectedRefundedCents: 0 },
    { refundCents: 1, expectedRefundedCents: Number.MAX_SAFE_INTEGER + 1 },
    { refundCents: 1000 },
    { expectedRefundedCents: 0 },
    { refundCents: undefined, expectedRefundedCents: undefined },
    { refundCents: "1000", expectedRefundedCents: 0 },
    { refundCents: 1000, expectedRefundedCents: 0, extra: true },
  ])(
    "rejects malformed or over-budget partial cents before GET: %j",
    async (amounts) => {
      const p = fixture();
      await expect(
        createStripeSandboxRefund(
          c,
          { ...a, ...amounts } as StripeSandboxRefundAssociation,
          p.call,
          async () => {},
        ),
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect(p.call).not.toHaveBeenCalled();
    },
  );
  it("rejects partial-field getters and symbol extras without invoking them", async () => {
    const p = fixture();
    const getter = vi.fn(() => 1000);
    const raw = {
      ...a,
      get refundCents() {
        return getter();
      },
      expectedRefundedCents: 0,
    };
    for (const input of [
      raw,
      { ...a, refundCents: 1000, expectedRefundedCents: 0, [Symbol()]: true },
    ]) {
      await expect(
        retrieveStripeSandboxRefund(c, input, p.call),
      ).rejects.toMatchObject({ code: "invalid_request" });
    }
    expect(getter).not.toHaveBeenCalled();
    expect(p.call).not.toHaveBeenCalled();
  });
  it.each([0, 999, 1001, 4005])(
    "rejects unexpected prior aggregate %s before partial POST",
    async (aggregate) => {
      const input = { ...a, refundCents: 3005, expectedRefundedCents: 1000 };
      const p = fixture(input);
      const hook = vi.fn(async () => {});
      p.ch.amount_refunded = aggregate;
      p.ch.refunded = aggregate === a.amountCents;
      await expect(
        createStripeSandboxRefund(c, input, p.call, hook),
      ).rejects.toMatchObject({ code: "invalid_response" });
      expect(hook).not.toHaveBeenCalled();
      expect(p.call.mock.calls.every(([, init]) => init.method === "GET")).toBe(
        true,
      );
    },
  );
  it.each([0, 1000, 1999, 2001, 4005])(
    "rejects succeeded partial refund with unexpected charge aggregate %s",
    async (aggregate) => {
      const input = { ...a, refundCents: 1000, expectedRefundedCents: 1000 };
      const p = fixture(input);
      p.refund.status = "succeeded";
      p.ch.amount_refunded = aggregate;
      p.ch.refunded = aggregate === a.amountCents;
      await expect(
        retrieveStripeSandboxRefund(c, input, p.call, "re_FictionalOnly123"),
      ).rejects.toMatchObject({ code: "invalid_response" });
    },
  );
  it.each([
    ["account", "id", "acct_OtherFictional123"],
    ["pi", "metadata", {}],
    ["pi", "amount_received", 1000],
    ["ch", "amount_captured", 1000],
    ["refund", "id", "re_OtherFictional123"],
    ["refund", "amount", 4005],
    ["refund", "currency", "usd"],
    ["refund", "charge", "ch_OtherFictional123"],
    ["refund", "payment_intent", "pi_OtherFictional123"],
    ["refund", "status", "unknown"],
    ["refund", "metadata", {}],
  ] as const)("rejects partial %s.%s mismatch", async (target, key, value) => {
    const input = { ...a, refundCents: 1000, expectedRefundedCents: 0 };
    const p = fixture(input);
    p[target][key] = value;
    await expect(
      retrieveStripeSandboxRefund(c, input, p.call, "re_FictionalOnly123"),
    ).rejects.toMatchObject({
      code: target === "account" ? "account_mismatch" : "invalid_response",
    });
  });
  it.each([
    "refund_version",
    "refund_amount_cents",
    "refund_expected_refunded_cents",
  ])("rejects partial refund metadata mismatch for %s", async (key) => {
    const input = { ...a, refundCents: 1000, expectedRefundedCents: 0 };
    const p = fixture(input);
    (p.refund.metadata as Record<string, string>)[key] = "wrong";
    await expect(
      retrieveStripeSandboxRefund(c, input, p.call),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
  it.each(["pending", "requires_action", "failed", "canceled"])(
    "reports no confirmed request cents for partial %s despite aggregate prior refunds",
    async (status) => {
      const input = { ...a, refundCents: 1000, expectedRefundedCents: 1000 };
      const p = fixture(input);
      p.refund.status = status;
      expect(
        await retrieveStripeSandboxRefund(
          c,
          input,
          p.call,
          "re_FictionalOnly123",
        ),
      ).toMatchObject({ status, amountCents: 4005, refundedCents: 0 });
    },
  );
  it("never retries an unknown partial POST and reconciles only with GETs", async () => {
    const input = { ...a, refundCents: 1000, expectedRefundedCents: 0 };
    const p = fixture(input);
    const transport = vi.fn<StripeSandboxFetch>(async (url, init) => {
      if (init.method === "POST")
        throw new Error("Synthetic lost acknowledgment");
      return p.call(url, init);
    });
    await expect(
      createStripeSandboxRefund(c, input, transport, async () => {}),
    ).rejects.toMatchObject({
      code: "unknown_outcome",
      operationKey: input.operationKey,
    });
    p.refund.status = "succeeded";
    p.ch.amount_refunded = 1000;
    expect(
      await retrieveStripeSandboxRefund(c, input, transport),
    ).toMatchObject({
      status: "succeeded",
      refundedCents: 1000,
    });
    expect(
      transport.mock.calls.filter(([, init]) => init.method === "POST"),
    ).toHaveLength(1);
  });
  it("rejects revoked authorization after partial canonical reads without a POST", async () => {
    const input = { ...a, refundCents: 1000, expectedRefundedCents: 1000 };
    const p = fixture(input);
    await expect(
      createStripeSandboxRefund(c, input, p.call, async () => {
        expect(p.call).toHaveBeenCalledTimes(3);
        throw new Error("Synthetic expired authorization");
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(p.call.mock.calls.every(([, init]) => init.method === "GET")).toBe(
      true,
    );
  });
  it("ignores unrelated earlier partial refunds but rejects ambiguous original request candidates", async () => {
    const input = { ...a, refundCents: 1000, expectedRefundedCents: 1000 };
    const p = fixture(input);
    const earlier = {
      ...p.refund,
      id: "re_EarlierFictional123",
      metadata: {
        ...(p.refund.metadata as Record<string, string>),
        refund_request_id: "66666666-6666-4666-8666-666666666666",
        refund_operation_key: "66666666-6666-4666-8666-666666666666",
      },
    };
    p.list.data.unshift(earlier);
    expect(await retrieveStripeSandboxRefund(c, input, p.call)).toMatchObject({
      refundId: "re_FictionalOnly123",
      status: "pending",
    });
    p.list.data.push({ ...p.refund, id: "re_AmbiguousFictional123" });
    await expect(
      retrieveStripeSandboxRefund(c, input, p.call),
    ).rejects.toMatchObject({
      code: "reconcile_required",
    });
  });
  it("preserves exact legacy POST metadata, query parameters and pending output", async () => {
    const p = fixture();
    await createStripeSandboxRefund(c, a, p.call, async () => {});
    expect(p.call.mock.calls.at(-1)![1].body).toBe(
      new URLSearchParams({
        charge: a.chargeId,
        amount: "4005",
        "metadata[test_mode]": "local-test",
        "metadata[instance_id]": c.instanceId,
        "metadata[account_ref]": c.expectedAccountId,
        "metadata[order_id]": a.orderId,
        "metadata[attempt_id]": a.paymentRequestId,
        "metadata[create_operation_key]": a.createOperationKey,
        "metadata[refund_request_id]": a.requestId,
        "metadata[refund_operation_key]": a.operationKey,
        "metadata[capture_id]": a.captureId,
      }).toString(),
    );
    p.ch.amount_refunded = 123;
    expect(await retrieveStripeSandboxRefund(c, a, p.call)).toEqual({
      refundId: "re_FictionalOnly123",
      status: "pending",
      amountCents: 4005,
      refundedCents: 123,
    });
    expect(p.call.mock.calls.at(-2)![0]).toBe(
      `https://api.stripe.com/v1/refunds?charge=${a.chargeId}&limit=100`,
    );
  });
});
