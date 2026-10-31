import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStripeSandboxSession as create,
  retrieveStripeSandboxSession as retrieve,
  retrieveStripeSandboxCapture as capture,
  expireStripeSandboxSession as expire,
  verifyStripeSandboxWebhook as verify,
  STRIPE_SANDBOX_API_VERSION as version,
  StripeSandboxError,
  type StripeSandboxAssociation,
  type StripeSandboxConfig,
  type StripeSandboxFetch,
} from "./stripe-sandbox.server";

// Generated nonfunctional dummy values; no account credentials, service calls or DB fixture.
function fixtureApiKey(mode: "test" | "live") {
  return ["sk", mode, "0".repeat(24)].join("_");
}
function fixtureSigningSecret(marker: "0" | "1" | "2") {
  return ["whsec", marker.repeat(24)].join("_");
}
const config: StripeSandboxConfig = {
  enabled: true,
  mode: "local-test",
  instanceId: "11111111-1111-4111-8111-111111111111",
  expectedAccountId: "acct_FictionalOnly123",
  testSecretKey: fixtureApiKey("test"),
  canonicalOrigin: "http://127.0.0.1:8791",
};
const now = 1_800_000_000_000;
const clock = () => now;
const input: StripeSandboxAssociation = {
  orderId: "order-22222222-2222-4222-8222-222222222222",
  attemptId: "33333333-3333-4333-8333-333333333333",
  createOperationKey: "44444444-4444-4444-8444-444444444444",
  amountCents: 4400,
  sessionExpiresAt: now / 1000 + 3600,
};
const sessionId = "cs_test_FictionalSession123";
const expireKey = "55555555-5555-4555-8555-555555555555";
const reference = { ...input, sessionId };
const expireInput = { ...reference, expireOperationKey: expireKey };
const scopeMetadata = {
  test_mode: "local-test",
  instance_id: config.instanceId,
  account_ref: config.expectedAccountId,
  order_id: input.orderId,
  attempt_id: input.attemptId,
  create_operation_key: input.createOperationKey,
};
function providerSession(overrides: Record<string, unknown> = {}) {
  return {
    id: sessionId,
    object: "checkout.session",
    livemode: false,
    mode: "payment",
    currency: "cad",
    amount_total: input.amountCents,
    client_reference_id: input.orderId,
    expires_at: input.sessionExpiresAt,
    status: "open",
    payment_status: "unpaid",
    payment_intent:
      overrides.payment_status === "paid" ? "pi_FictionalIntent123" : null,
    metadata: { ...scopeMetadata },
    url: "https://checkout.stripe.com/c/pay/fictional#test",
    customer_details: { email: "private-fixture@example.invalid" },
    ...overrides,
  };
}
const paymentIntentId = "pi_FictionalIntent123";
const chargeId = "ch_FictionalCharge123";
function paidSession(overrides: Record<string, unknown> = {}) {
  return providerSession({
    status: "complete",
    payment_status: "paid",
    url: null,
    ...overrides,
  });
}
function paymentIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: paymentIntentId,
    object: "payment_intent",
    status: "succeeded",
    currency: "cad",
    amount: input.amountCents,
    amount_received: input.amountCents,
    amount_capturable: 0,
    livemode: false,
    latest_charge: chargeId,
    metadata: { ...scopeMetadata },
    client_secret: "private-fixture-client-secret",
    receipt_email: "private-fixture@example.invalid",
    ...overrides,
  };
}
function charge(overrides: Record<string, unknown> = {}) {
  return {
    id: chargeId,
    object: "charge",
    payment_intent: paymentIntentId,
    status: "succeeded",
    currency: "cad",
    amount: input.amountCents,
    amount_captured: input.amountCents,
    amount_refunded: 0,
    paid: true,
    captured: true,
    refunded: false,
    disputed: false,
    livemode: false,
    billing_details: { email: "private-fixture@example.invalid" },
    ...overrides,
  };
}
const account = () =>
  Response.json({ id: config.expectedAccountId, object: "account" });
function fetcher(...responses: (() => Response | Promise<Response>)[]) {
  const call = vi.fn<StripeSandboxFetch>();
  for (const respond of responses)
    call.mockImplementationOnce(async () => respond());
  call.mockRejectedValue(new Error("Unexpected extra request"));
  return call;
}
beforeEach(() => {
  // A missing injection must NEVER select native/global fetch.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Forbidden external request");
    }),
  );
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isolated Stripe Sandbox transport", () => {
  it("sends pinned card-only CAD parameters and stable same-key retries without caller PII", async () => {
    const call = fetcher(
      account,
      () => Response.json(providerSession()),
      account,
      () => Response.json(providerSession()),
    );
    const result = await create(config, input, call, clock);
    await create(config, input, call, () => now + 1000);
    expect(call.mock.calls.map(([url]) => url)).toEqual([
      "https://api.stripe.com/v1/account",
      "https://api.stripe.com/v1/checkout/sessions",
      "https://api.stripe.com/v1/account",
      "https://api.stripe.com/v1/checkout/sessions",
    ]);
    const first = call.mock.calls[1][1],
      retry = call.mock.calls[3][1];
    expect(first.body).toBe(retry.body);
    expect(first).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${config.testSecretKey}`,
        "Stripe-Version": version,
        "Idempotency-Key": input.createOperationKey,
      },
    });
    expect(new Headers(first.headers).has("Stripe-Account")).toBe(false);
    const body = new URLSearchParams(first.body as string);
    expect(body.get("line_items[0][price_data][unit_amount]")).toBe("4400");
    expect(body.get("payment_method_types[0]")).toBe("card");
    expect(body.get("mode")).toBe("payment");
    expect(body.get("currency")).toBe("cad");
    expect(body.get("adaptive_pricing[enabled]")).toBe("false");
    expect(body.get("success_url")).toBe(
      `${config.canonicalOrigin}/checkout/orders/${input.orderId}?stripe_return=success`,
    );
    expect(body.get("cancel_url")).toBe(
      `${config.canonicalOrigin}/checkout/orders/${input.orderId}?stripe_return=cancel`,
    );
    expect(body.get("expires_at")).toBe(String(input.sessionExpiresAt));
    for (const [key, value] of Object.entries(scopeMetadata)) {
      expect(body.get(`metadata[${key}]`)).toBe(value);
      expect(body.get(`payment_intent_data[metadata][${key}]`)).toBe(value);
    }
    expect(
      [...body.keys()].some((key) => /customer|email|address/.test(key)),
    ).toBe(false);
    expect(result).toEqual({
      ...input,
      sessionId,
      status: "open",
      paymentStatus: "unpaid",
      paymentIntentId: null,
      hostedUrl: providerSession().url,
      currency: "CAD",
      testOnly: true,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /customer|private-fixture|sk_test/,
    );
  });
  it("fails closed on missing/disabled/live config, bad origin, and missing explicit transport", async () => {
    const call = fetcher();
    for (const bad of [
      undefined,
      {},
      { ...config, enabled: false },
      { ...config, mode: "live" },
      { ...config, testSecretKey: fixtureApiKey("live") },
      { ...config, canonicalOrigin: "https://127.0.0.1:8791" },
      { ...config, canonicalOrigin: "http://127.0.0.1:8791/path" },
      { ...config, canonicalOrigin: "http://example.invalid:8791" },
    ])
      await expect(create(bad, input, call, clock)).rejects.toMatchObject({
        code: "invalid_config",
      });
    await expect(
      create(config, input, undefined as unknown as StripeSandboxFetch, clock),
    ).rejects.toMatchObject({ code: "invalid_config" });
    expect(call).not.toHaveBeenCalled();
  });
  it("rejects caller getters, symbols, prototype/extra fields and unsafe amounts before dispatch", async () => {
    const call = fetcher(),
      getter = vi.fn(() => input.amountCents);
    const accessor = { ...input };
    Object.defineProperty(accessor, "amountCents", { get: getter });
    for (const bad of [
      accessor,
      { ...input, [Symbol("extra")]: 1 },
      Object.create(input),
      { ...input, email: "no@example.invalid" },
      { ...input, amountCents: 1.5 },
      { ...input, amountCents: 0 },
      { ...input, amountCents: 100_000_000 },
      { ...input, sessionExpiresAt: Infinity },
      { ...input, orderId: "../order" },
    ])
      await expect(create(config, bad, call, clock)).rejects.toMatchObject({
        code: "invalid_request",
      });
    expect(getter).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });
  it("copies own input/config before account await and accepts null-prototype data", async () => {
    const mutable = Object.assign(
        Object.create(null),
        input,
      ) as StripeSandboxAssociation,
      settings = { ...config };
    const call = fetcher(
      () => {
        mutable.amountCents = 9;
        settings.expectedAccountId = "acct_Changed123";
        settings.testSecretKey = fixtureApiKey("live");
        return account();
      },
      () => Response.json(providerSession()),
    );
    await create(settings, mutable, call, clock);
    expect(
      new URLSearchParams(call.mock.calls[1][1].body as string).get(
        "line_items[0][price_data][unit_amount]",
      ),
    ).toBe("4400");
    expect(
      new Headers(call.mock.calls[1][1].headers).get("Authorization"),
    ).toBe(`Bearer ${config.testSecretKey}`);
  });
  it("requires a fixed 30min–24h provider expiry, rechecks after account lookup, and never extends it", async () => {
    const call = fetcher();
    await expect(
      create(
        config,
        { ...input, sessionExpiresAt: now / 1000 + 600 },
        call,
        clock,
      ),
    ).rejects.toMatchObject({
      code: "reconcile_required",
      operationKey: input.createOperationKey,
    });
    await expect(
      create(
        config,
        { ...input, sessionExpiresAt: now / 1000 + 86401 },
        call,
        clock,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(call).not.toHaveBeenCalled();
    let current = now;
    const delayed = fetcher(() => {
      current += 1801_000;
      return account();
    });
    await expect(
      create(config, input, delayed, () => current),
    ).rejects.toMatchObject({ code: "reconcile_required" });
    expect(delayed).toHaveBeenCalledTimes(1);
  });
  it("checks the configured account on every operation and never dispatches to a mismatched account", async () => {
    for (const action of [
      (call: StripeSandboxFetch) => create(config, input, call, clock),
      (call: StripeSandboxFetch) => retrieve(config, reference, call),
      (call: StripeSandboxFetch) => capture(config, reference, call),
      (call: StripeSandboxFetch) => expire(config, expireInput, call),
    ]) {
      const call = fetcher(() =>
        Response.json({ id: "acct_WrongAccount123", object: "account" }),
      );
      await expect(action(call)).rejects.toMatchObject({
        code: "account_mismatch",
      });
      expect(call).toHaveBeenCalledTimes(1);
    }
  });

  it("treats a lost mutation response as unknown and retries only with the original key/parameters", async () => {
    const call = fetcher(
      account,
      () => {
        throw new Error("secret/raw upstream response");
      },
      account,
      () => Response.json(providerSession()),
    );
    const error = await create(config, input, call, clock).catch(
      (error) => error,
    );
    expect(error).toBeInstanceOf(StripeSandboxError);
    expect(error).toMatchObject({
      code: "unknown_outcome",
      operationKey: input.createOperationKey,
    });
    expect(error.message).not.toMatch(/secret|upstream/);
    expect(error.cause).toBeUndefined();
    await create(config, input, call, clock);
    expect(call.mock.calls[1][1].body).toBe(call.mock.calls[3][1].body);
    expect(
      new Headers(call.mock.calls[3][1].headers).get("Idempotency-Key"),
    ).toBe(input.createOperationKey);
  });
  it("allows a completed same-key create replay but never interprets an open redirect as paid", async () => {
    const call = fetcher(account, () =>
      Response.json(
        providerSession({
          status: "complete",
          payment_status: "paid",
          url: null,
        }),
      ),
    );
    expect(await create(config, input, call, clock)).toMatchObject({
      status: "complete",
      paymentStatus: "paid",
      paymentIntentId: "pi_FictionalIntent123",
      hostedUrl: null,
    });
    expect(
      await retrieve(
        config,
        reference,
        fetcher(account, () => Response.json(providerSession())),
      ),
    ).toMatchObject({ status: "open", paymentStatus: "unpaid" });
  });
  it("rejects live, wrong-session, amount/currency/reference/metadata and hostile redirect responses", async () => {
    for (const changed of [
      {
        status: "complete",
        payment_status: "paid",
        payment_intent: null,
        url: null,
      },
      { payment_intent: { id: "pi_FictionalIntent123" } },
      { payment_intent: "not-an-intent" },
      { livemode: true },
      { id: "cs_live_FictionalSession123" },
      { id: "cs_test_OtherSession123" },
      { amount_total: 4401 },
      { currency: "usd" },
      { client_reference_id: "other" },
      { metadata: { ...scopeMetadata, instance_id: "other" } },
      { metadata: { ...scopeMetadata, account_ref: "acct_other" } },
      {
        metadata: {
          ...scopeMetadata,
          create_operation_key: crypto.randomUUID(),
        },
      },
      { url: "https://checkout.stripe.com.evil.invalid/pay" },
      { url: "https://user:password@checkout.stripe.com/pay" },
      { url: "http://checkout.stripe.com/pay" },
      { url: "https://checkout.stripe.com:444/pay" },
      { status: "open", payment_status: "paid" },
    ])
      await expect(
        retrieve(
          config,
          reference,
          fetcher(account, () => Response.json(providerSession(changed))),
        ),
      ).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("retrieves association before expiring with its distinct key, and preserves complete/expired distinctions", async () => {
    const call = fetcher(
      account,
      () => Response.json(providerSession()),
      () => Response.json(providerSession({ status: "expired", url: null })),
    );
    expect(await expire(config, expireInput, call)).toMatchObject({
      status: "expired",
      paymentStatus: "unpaid",
      paymentIntentId: null,
      hostedUrl: null,
    });
    expect(call.mock.calls[2][0]).toBe(
      `https://api.stripe.com/v1/checkout/sessions/${sessionId}/expire`,
    );
    expect(
      new Headers(call.mock.calls[2][1].headers).get("Idempotency-Key"),
    ).toBe(expireKey);
    const completed = fetcher(account, () =>
      Response.json(
        providerSession({
          status: "complete",
          payment_status: "paid",
          url: null,
        }),
      ),
    );
    await expect(expire(config, expireInput, completed)).rejects.toMatchObject({
      code: "reconcile_required",
    });
    expect(completed).toHaveBeenCalledTimes(2);
    const expired = fetcher(account, () =>
      Response.json(providerSession({ status: "expired", url: null })),
    );
    expect(await expire(config, expireInput, expired)).toMatchObject({
      status: "expired",
    });
    expect(expired).toHaveBeenCalledTimes(2);
    const invalid = fetcher();
    await expect(
      expire(
        config,
        { ...expireInput, expireOperationKey: input.createOperationKey },
        invalid,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(invalid).not.toHaveBeenCalled();
  });
  it("does not expire mismatched sessions and treats expiry response loss as uncertain", async () => {
    const mismatch = fetcher(account, () =>
      Response.json(providerSession({ amount_total: 100 })),
    );
    await expect(expire(config, expireInput, mismatch)).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(mismatch).toHaveBeenCalledTimes(2);
    const lost = fetcher(
      account,
      () => Response.json(providerSession()),
      () => {
        throw new Error("lost");
      },
    );
    await expect(expire(config, expireInput, lost)).rejects.toMatchObject({
      code: "unknown_outcome",
      operationKey: expireKey,
    });
  });
  it("bounds declared/streamed responses and sanitizes bad JSON, HTTP errors and redirects without retries", async () => {
    for (const response of [
      () =>
        new Response("{", { headers: { "Content-Type": "application/json" } }),
      () =>
        new Response("x", {
          headers: {
            "Content-Type": "application/json",
            "Content-Length": "131073",
          },
        }),
      () =>
        new Response("x".repeat(131073), {
          headers: { "Content-Type": "application/json" },
        }),
      () => new Response("private upstream body", { status: 500 }),
      () => new Response("private upstream body", { status: 400 }),
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://evil.invalid" },
        }),
    ]) {
      const call = fetcher(account, response);
      const result = await create(config, input, call, clock).catch(
        (error) => error,
      );
      expect(result).toMatchObject({ code: "unknown_outcome" });
      expect(result.message).not.toMatch(/upstream|131073/);
      expect(call).toHaveBeenCalledTimes(2);
    }
  });
  it("bounds hanging requests and body reads to ten seconds, aborts, and never retries", async () => {
    vi.useFakeTimers();
    for (const phase of ["account", "mutation", "body"]) {
      const cancelled = vi.fn();
      const hanging = () => new Promise<Response>(() => {});
      const call =
        phase === "account"
          ? fetcher(hanging)
          : fetcher(
              account,
              phase === "mutation"
                ? hanging
                : () =>
                    new Response(new ReadableStream({ cancel: cancelled }), {
                      headers: { "Content-Type": "application/json" },
                    }),
            );
      const result = create(config, input, call, clock).catch((error) => error);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await result).toMatchObject({
        code: phase === "account" ? "unavailable" : "unknown_outcome",
      });
      expect(call.mock.calls.at(-1)![1].signal!.aborted).toBe(true);
      if (phase === "body") expect(cancelled).toHaveBeenCalledTimes(1);
      expect(call).toHaveBeenCalledTimes(phase === "account" ? 1 : 2);
    }
  });
});

describe("canonical Stripe Sandbox capture", () => {
  it("retrieves account, Session, PaymentIntent and latest Charge before returning only safe full-capture facts", async () => {
    const call = fetcher(
      account,
      () => Response.json(paidSession()),
      () => Response.json(paymentIntent()),
      () => Response.json(charge()),
    );
    const result = await capture(config, reference, call);
    expect(result).toEqual({
      paymentIntentId,
      chargeId,
      amountCents: 4400,
      currency: "CAD",
    });
    expect(call.mock.calls.map(([url]) => url)).toEqual([
      "https://api.stripe.com/v1/account",
      `https://api.stripe.com/v1/checkout/sessions/${sessionId}`,
      `https://api.stripe.com/v1/payment_intents/${paymentIntentId}`,
      `https://api.stripe.com/v1/charges/${chargeId}`,
    ]);
    for (const [, init] of call.mock.calls) {
      expect(init.method).toBe("GET");
      expect(init.body).toBeUndefined();
      expect(init.redirect).toBe("error");
      expect(new Headers(init.headers).get("Stripe-Version")).toBe(version);
      expect(new Headers(init.headers).get("Authorization")).toBe(
        `Bearer ${config.testSecretKey}`,
      );
    }
    expect(JSON.stringify(result)).not.toMatch(
      /private-fixture|client_secret|billing_details|receipt_email|sk_test/,
    );
  });

  it("retains an unpaid/delayed/canceled Session as reconciliation work, never capture proof", async () => {
    for (const value of [
      providerSession(),
      providerSession({ status: "expired", url: null }),
      providerSession({
        status: "complete",
        payment_status: "unpaid",
        url: null,
      }),
    ]) {
      const call = fetcher(account, () => Response.json(value));
      await expect(capture(config, reference, call)).rejects.toMatchObject({
        code: "reconcile_required",
      });
      expect(call).toHaveBeenCalledTimes(2);
    }
  });

  it("rejects Session association, amount, currency and live-mode mismatches before reading financial objects", async () => {
    for (const value of [
      { id: "cs_test_OtherSession123" },
      { payment_intent: null },
      { amount_total: 4401 },
      { currency: "usd" },
      { client_reference_id: "other-order" },
      { livemode: true },
      { metadata: { ...scopeMetadata, account_ref: "acct_OtherAccount123" } },
    ]) {
      const call = fetcher(account, () => Response.json(paidSession(value)));
      await expect(capture(config, reference, call)).rejects.toMatchObject({
        code: "invalid_response",
      });
      expect(call).toHaveBeenCalledTimes(2);
    }
  });

  it("rejects failed/pending/partial/unassociated intents even if the Session claims paid", async () => {
    for (const changed of [
      { id: "pi_OtherIntent123" },
      { object: "charge" },
      { status: "requires_payment_method" },
      { status: "processing" },
      { status: "requires_capture" },
      { status: "canceled" },
      { currency: "usd" },
      { amount: 4401 },
      { amount_received: 4399 },
      { amount_received: 4401 },
      { amount_capturable: 4400 },
      { livemode: true },
      { latest_charge: null },
      { latest_charge: { id: chargeId } },
      { latest_charge: "../../account" },
      { metadata: null },
      ...Object.keys(scopeMetadata).map((key) => ({
        metadata: { ...scopeMetadata, [key]: "different" },
      })),
    ]) {
      const call = fetcher(
        account,
        () => Response.json(paidSession()),
        () => Response.json(paymentIntent(changed)),
      );
      await expect(capture(config, reference, call)).rejects.toMatchObject({
        code: "invalid_response",
      });
      expect(call).toHaveBeenCalledTimes(3);
    }
  });

  it("rejects authorization-only, partial, refunded, disputed or mismatched latest charges", async () => {
    for (const changed of [
      { id: "ch_OtherCharge123" },
      { object: "payment_intent" },
      { payment_intent: "pi_OtherIntent123" },
      { payment_intent: { id: paymentIntentId } },
      { status: "pending" },
      { status: "failed" },
      { paid: false },
      { captured: false },
      { currency: "usd" },
      { amount: 4399 },
      { amount_captured: 4399 },
      { amount_captured: 4401 },
      { refunded: true },
      { amount_refunded: 1 },
      { disputed: true },
      { livemode: true },
    ]) {
      const call = fetcher(
        account,
        () => Response.json(paidSession()),
        () => Response.json(paymentIntent()),
        () => Response.json(charge(changed)),
      );
      await expect(capture(config, reference, call)).rejects.toMatchObject({
        code: "invalid_response",
      });
      expect(call).toHaveBeenCalledTimes(4);
    }
  });

  it("can verify a later canonical capture without changing the original association", async () => {
    const delayed = fetcher(
      account,
      () => Response.json(paidSession()),
      () => Response.json(paymentIntent()),
      () => Response.json(charge({ captured: false, amount_captured: 0 })),
    );
    await expect(capture(config, reference, delayed)).rejects.toMatchObject({
      code: "invalid_response",
    });
    const later = fetcher(
      account,
      () => Response.json(paidSession()),
      () => Response.json(paymentIntent()),
      () => Response.json(charge()),
    );
    await expect(capture(config, reference, later)).resolves.toEqual({
      paymentIntentId,
      chargeId,
      amountCents: input.amountCents,
      currency: "CAD",
    });
  });

  it("bounds failed and timed-out financial reads without retry or upstream secret exposure", async () => {
    for (const phase of ["intent", "charge"]) {
      const prefix = [
        account,
        () => Response.json(paidSession()),
        ...(phase === "charge" ? [() => Response.json(paymentIntent())] : []),
      ];
      const failed = fetcher(...prefix, () => {
        throw new Error(`private upstream ${config.testSecretKey}`);
      });
      const error = await capture(config, reference, failed).catch(
        (error) => error,
      );
      expect(error).toBeInstanceOf(StripeSandboxError);
      expect(error).toMatchObject({
        code: "unavailable",
        message: "Stripe test operation could not be verified",
      });
      expect(error.cause).toBeUndefined();
      expect(failed).toHaveBeenCalledTimes(phase === "intent" ? 3 : 4);
      vi.useFakeTimers();
      const hanging = fetcher(...prefix, () => new Promise<Response>(() => {}));
      const result = capture(config, reference, hanging).catch(
        (error) => error,
      );
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await result).toMatchObject({ code: "unavailable" });
      expect(hanging.mock.calls.at(-1)![1].signal!.aborted).toBe(true);
      expect(hanging).toHaveBeenCalledTimes(phase === "intent" ? 3 : 4);
      vi.useRealTimers();
    }
  });

  it("rejects unsafe capture input before any injected transport is used", async () => {
    const call = fetcher();
    for (const bad of [
      { ...reference, sessionId: "../../account" },
      { ...reference, amountCents: 0 },
      { ...reference, customer: "untrusted" },
    ])
      await expect(capture(config, bad, call)).rejects.toMatchObject({
        code: "invalid_request",
      });
    await expect(
      capture({ ...config, mode: "live" }, reference, call),
    ).rejects.toMatchObject({ code: "invalid_config" });
    expect(call).not.toHaveBeenCalled();
  });
});

const signingSecret = fixtureSigningSecret("0");
const webhookConfig = {
  enabled: true,
  mode: "local-test",
  instanceId: config.instanceId,
  expectedAccountId: config.expectedAccountId,
  signingSecrets: [signingSecret],
};
const encoder = new TextEncoder();
function event(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_FictionalEvent123",
    object: "event",
    api_version: version,
    livemode: false,
    created: now / 1000,
    type: "checkout.session.completed",
    data: {
      object: providerSession({
        status: "complete",
        payment_status: "paid",
        url: null,
      }),
    },
    ...overrides,
  };
}
async function signed(
  payload: unknown,
  timestamp = now / 1000,
  secret = signingSecret,
) {
  const body = encoder.encode(
    typeof payload === "string" ? payload : JSON.stringify(payload),
  );
  const prefix = encoder.encode(`${timestamp}.`),
    bytes = new Uint8Array(prefix.length + body.length);
  bytes.set(prefix);
  bytes.set(body, prefix.length);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes));
  const hex = [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return { body, signature: `t=${timestamp},v1=${hex}` };
}
describe("bounded raw-byte Stripe Webhook verification", () => {
  it("verifies raw bytes and minimally projects a direct-account event without implying dedupe/financial authorization", async () => {
    const { body, signature } = await signed(event());
    const first = await verify(webhookConfig, body, signature, clock);
    expect(first).toMatchObject({
      eventId: "evt_FictionalEvent123",
      eventType: "checkout.session.completed",
      apiVersion: version,
      session: { sessionId, amountCents: 4400 },
    });
    expect(await verify(webhookConfig, body, signature, clock)).toEqual(first);
    expect(JSON.stringify(first)).not.toMatch(
      /customer_details|private-fixture|whsec|metadata/,
    );
  });
  it("accepts rotation/multiple v1 signatures but not v0-only or invalid raw bytes", async () => {
    const { body, signature } = await signed(event());
    expect(
      await verify(
        {
          ...webhookConfig,
          signingSecrets: [fixtureSigningSecret("1"), signingSecret],
        },
        body,
        `${signature},v1=${"0".repeat(64)}`,
        clock,
      ),
    ).toMatchObject({ testOnly: true });
    for (const header of [
      signature.replace("v1=", "v0="),
      `${signature},t=${now / 1000}`,
      "t=NaN,v1=abcd",
      `${signature},unknown=value`,
    ])
      await expect(
        verify(webhookConfig, body, header, clock),
      ).rejects.toMatchObject({ code: "invalid_signature" });
    const changed = new Uint8Array(body);
    changed[changed.length - 1] = 32;
    await expect(
      verify(webhookConfig, changed, signature, clock),
    ).rejects.toMatchObject({ code: "invalid_signature" });
  });
  it("uses a 300-second past/future tolerance including equality and rechecks the clock after crypto", async () => {
    for (const offset of [-301, -300, 300, 301]) {
      const data = await signed(event(), now / 1000 + offset);
      if (Math.abs(offset) === 300)
        expect(
          await verify(webhookConfig, data.body, data.signature, clock),
        ).toMatchObject({ testOnly: true });
      else
        await expect(
          verify(webhookConfig, data.body, data.signature, clock),
        ).rejects.toMatchObject({ code: "invalid_signature" });
    }
    const data = await signed(event());
    let reads = 0;
    await expect(
      verify(
        webhookConfig,
        data.body,
        data.signature,
        () => now + (reads++ ? 301000 : 0),
      ),
    ).rejects.toMatchObject({ code: "invalid_signature" });
  });
  it("rejects verified but live/wrong-account/wrong-scope/version/type/amount envelopes", async () => {
    const invalidEvents = [
      event({ livemode: true }),
      event({ account: "acct_WrongAccount123" }),
      event({ api_version: "old" }),
      event({ type: "customer.created" }),
      event({
        data: {
          object: providerSession({
            status: "complete",
            url: null,
            metadata: { ...scopeMetadata, instance_id: "wrong" },
          }),
        },
      }),
      event({
        data: {
          object: providerSession({
            status: "complete",
            url: null,
            amount_total: -1,
          }),
        },
      }),
      event({ data: { object: providerSession({ status: "open" }) } }),
    ];
    for (const value of invalidEvents) {
      const data = await signed(value);
      await expect(
        verify(webhookConfig, data.body, data.signature, clock),
      ).rejects.toMatchObject({ code: "invalid_event" });
    }
    const sameAccount = await signed(
      event({ account: config.expectedAccountId }),
    );
    expect(
      await verify(
        webhookConfig,
        sameAccount.body,
        sameAccount.signature,
        clock,
      ),
    ).toMatchObject({ testOnly: true });
  });
  it("rejects oversized/malformed inputs and copies byte/secret inputs before awaiting crypto", async () => {
    const data = await signed(event());
    await expect(
      verify(webhookConfig, new Uint8Array(131073), data.signature, clock),
    ).rejects.toMatchObject({ code: "invalid_signature" });
    await expect(
      verify(webhookConfig, data.body, "x".repeat(4097), clock),
    ).rejects.toMatchObject({ code: "invalid_signature" });
    const invalid = await signed("{broken");
    await expect(
      verify(webhookConfig, invalid.body, invalid.signature, clock),
    ).rejects.toMatchObject({ code: "invalid_event" });
    const settings = { ...webhookConfig, signingSecrets: [signingSecret] };
    const promise = verify(settings, data.body, data.signature, clock);
    data.body.fill(0);
    settings.signingSecrets[0] = fixtureSigningSecret("2");
    expect(await promise).toMatchObject({ testOnly: true });
  });
});
