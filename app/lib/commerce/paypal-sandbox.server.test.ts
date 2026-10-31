import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPayPalSandboxOrder as create,
  retrievePayPalSandboxOrder as retrieve,
  capturePayPalSandboxOrder as capture,
  retrievePayPalSandboxCapture as facts,
  verifyPayPalSandboxWebhook as verify,
  PayPalSandboxError,
  type PayPalSandboxConfig,
  type PayPalSandboxAssociation,
  type PayPalSandboxFetch,
} from "./paypal-sandbox.server";

// Generated nonfunctional credentials; tests never contact a provider or native fetch.
const credential = (marker: string) => marker.repeat(32);
const config: PayPalSandboxConfig = {
  enabled: true,
  mode: "local-test",
  instanceId: "11111111-1111-4111-8111-111111111111",
  expectedMerchantId: "ABCDEFGHJKLMN",
  clientId: credential("0"),
  clientSecret: credential("1"),
  canonicalOrigin: "http://127.0.0.1:8791",
};
const input: PayPalSandboxAssociation = {
  orderId: "order-22222222-2222-4222-8222-222222222222",
  attemptId: "33333333-3333-4333-8333-333333333333",
  createOperationKey: "44444444-4444-4444-8444-444444444444",
  amountCents: 4400,
};
const providerOrderId = "5O190127TN364715T";
const captureId = "3C679366HH908993F";
const reference = { ...input, providerOrderId };
const captureOperationKey = "55555555-5555-4555-8555-555555555555";
const captureInput = { ...reference, captureOperationKey };
const origin = "https://api-m.sandbox.paypal.com";
const customId = `local-test:${config.instanceId}:${input.attemptId}:${input.createOperationKey}`;
const money = { currency_code: "CAD", value: "44.00" };
function unit(overrides: Record<string, unknown> = {}) {
  return {
    reference_id: input.orderId,
    custom_id: customId,
    payee: { merchant_id: config.expectedMerchantId },
    amount: { ...money },
    ...overrides,
  };
}
function order(overrides: Record<string, unknown> = {}) {
  return {
    id: providerOrderId,
    intent: "CAPTURE",
    status: "PAYER_ACTION_REQUIRED",
    purchase_units: [unit()],
    links: [
      {
        rel: "payer-action",
        method: "GET",
        href: `https://www.sandbox.paypal.com/checkoutnow?token=${providerOrderId}`,
      },
    ],
    payer: { email_address: "private-fixture@example.invalid" },
    ...overrides,
  };
}
function captured(overrides: Record<string, unknown> = {}) {
  return {
    id: captureId,
    status: "COMPLETED",
    final_capture: true,
    amount: { ...money },
    custom_id: customId,
    payee: { merchant_id: config.expectedMerchantId },
    supplementary_data: { related_ids: { order_id: providerOrderId } },
    ...overrides,
  };
}
function paidOrder(overrides: Record<string, unknown> = {}) {
  return order({
    status: "COMPLETED",
    links: [],
    purchase_units: [unit({ payments: { captures: [captured()] } })],
    ...overrides,
  });
}
const token = () =>
  Response.json({
    access_token: credential("2"),
    token_type: "Bearer",
    expires_in: 3600,
  });
function fetcher(...responses: (() => Response | Promise<Response>)[]) {
  const call = vi.fn<PayPalSandboxFetch>();
  for (const respond of responses)
    call.mockImplementationOnce(async () => respond());
  call.mockRejectedValue(new Error("Unexpected extra injected request"));
  return call;
}
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Forbidden provider request");
    }),
  );
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PayPal Sandbox transport", () => {
  it("creates one frozen CAD purchase unit, separate scoped metadata, and hosted test approval without customer input", async () => {
    const call = fetcher(
      token,
      () => Response.json(order()),
      token,
      () => Response.json(order()),
    );
    const result = await create(config, input, call);
    await create(config, input, call);
    expect(result).toEqual({
      testOnly: true,
      ...input,
      providerOrderId,
      status: "PAYER_ACTION_REQUIRED",
      currency: "CAD",
      approvalUrl: order().links[0].href,
    });
    expect(call.mock.calls.map(([url]) => url)).toEqual([
      `${origin}/v1/oauth2/token`,
      `${origin}/v2/checkout/orders`,
      `${origin}/v1/oauth2/token`,
      `${origin}/v2/checkout/orders`,
    ]);
    const authRequest = call.mock.calls[0][1];
    expect(new Headers(authRequest.headers).get("Authorization")).toBe(
      `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
    );
    expect(authRequest.body).toBe("grant_type=client_credentials");
    const sent = call.mock.calls[1][1];
    expect(sent.body).toBe(call.mock.calls[3][1].body);
    expect(new Headers(sent.headers).get("PayPal-Request-Id")).toBe(
      input.createOperationKey,
    );
    expect(new Headers(sent.headers).get("Prefer")).toBe(
      "return=representation",
    );
    expect(new Headers(sent.headers).get("Authorization")).toBe(
      `Bearer ${credential("2")}`,
    );
    expect(sent.redirect).toBe("error");
    const body = JSON.parse(sent.body as string);
    expect(body).toEqual({
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: input.orderId,
          custom_id: customId,
          description: "Fictional local test order — no real purchase",
          amount: money,
          payee: { merchant_id: config.expectedMerchantId },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            shipping_preference: "NO_SHIPPING",
            user_action: "PAY_NOW",
            payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED",
            return_url: `${config.canonicalOrigin}/checkout/orders/${input.orderId}?paypal_return=success`,
            cancel_url: `${config.canonicalOrigin}/checkout/orders/${input.orderId}?paypal_return=cancel`,
          },
        },
      },
    });
    expect(customId.length).toBeLessThanOrEqual(127);
    expect(JSON.stringify(result)).not.toMatch(
      /private-fixture|clientId|clientSecret|access_token|payer/,
    );
  });

  it("fails closed on config and caller input before transport; never selects global fetch", async () => {
    const call = fetcher();
    for (const bad of [
      undefined,
      {},
      { ...config, enabled: false },
      { ...config, mode: "live" },
      { ...config, canonicalOrigin: "https://example.invalid" },
      { ...config, canonicalOrigin: "http://127.0.0.1:8791/path" },
      { ...config, expectedMerchantId: "INVALID000000" },
      { ...config, clientId: "short" },
      { ...config, clientId: `${credential("0")}:injected` },
      { ...config, clientSecret: `${credential("1")}\nX:value` },
    ])
      await expect(create(bad, input, call)).rejects.toMatchObject({
        code: "invalid_config",
      });
    const getter = vi.fn(() => input.amountCents),
      accessor = { ...input };
    Object.defineProperty(accessor, "amountCents", { get: getter });
    for (const bad of [
      accessor,
      Object.create(input),
      { ...input, [Symbol("extra")]: 1 },
      { ...input, email: "x@example.invalid" },
      { ...input, amountCents: 0 },
      { ...input, amountCents: 1.1 },
      { ...input, amountCents: 100_000_000 },
      { ...input, attemptId: "../other" },
    ])
      await expect(create(config, bad, call)).rejects.toMatchObject({
        code: "invalid_request",
      });
    await expect(
      create(config, input, undefined as unknown as PayPalSandboxFetch),
    ).rejects.toMatchObject({ code: "invalid_config" });
    expect(getter).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it("copies caller configuration and association before awaiting OAuth", async () => {
    const settings = { ...config },
      mutable = { ...input };
    const call = fetcher(
      () => {
        mutable.amountCents = 1;
        settings.expectedMerchantId = "BCDEFGHJKLMNP";
        settings.clientSecret = "mutated";
        return token();
      },
      () => Response.json(order()),
    );
    expect(await create(settings, mutable, call)).toMatchObject({
      amountCents: 4400,
    });
    expect(
      JSON.parse(call.mock.calls[1][1].body as string).purchase_units[0].payee
        .merchant_id,
    ).toBe(config.expectedMerchantId);
  });

  it("accepts only canonical matching single-unit CAD orders and excludes approval from payment proof", async () => {
    for (const changed of [
      { id: "OTHERORDER123" },
      { intent: "AUTHORIZE" },
      { status: "UNKNOWN" },
      { purchase_units: [] },
      { purchase_units: [unit(), unit()] },
      { purchase_units: [unit({ reference_id: "wrong-order" })] },
      { purchase_units: [unit({ custom_id: "wrong-instance-attempt-key" })] },
      { purchase_units: [unit({ amount: { ...money, value: "44.01" } })] },
      {
        purchase_units: [unit({ amount: { ...money, currency_code: "USD" } })],
      },
    ]) {
      const call = fetcher(token, () => Response.json(order(changed)));
      await expect(retrieve(config, reference, call)).rejects.toMatchObject({
        code: "invalid_response",
      });
      expect(call).toHaveBeenCalledTimes(2);
    }
    await expect(
      retrieve(
        config,
        reference,
        fetcher(token, () =>
          Response.json(
            order({
              purchase_units: [
                unit({ payee: { merchant_id: "BCDEFGHJKLMNP" } }),
              ],
            }),
          ),
        ),
      ),
    ).rejects.toMatchObject({ code: "account_mismatch" });
    expect(
      await retrieve(
        config,
        reference,
        fetcher(token, () =>
          Response.json(order({ status: "APPROVED", links: [] })),
        ),
      ),
    ).toMatchObject({ status: "APPROVED", approvalUrl: null });
  });

  it("rejects hostile/live/mismatched approval links without following them", async () => {
    for (const href of [
      `https://www.paypal.com/checkoutnow?token=${providerOrderId}`,
      `https://www.sandbox.paypal.com.evil.invalid/checkoutnow?token=${providerOrderId}`,
      `https://user:password@www.sandbox.paypal.com/checkoutnow?token=${providerOrderId}`,
      `https://www.sandbox.paypal.com:444/checkoutnow?token=${providerOrderId}`,
      `http://www.sandbox.paypal.com/checkoutnow?token=${providerOrderId}`,
      "https://www.sandbox.paypal.com/checkoutnow?token=OTHER",
      `https://www.sandbox.paypal.com/unknown?token=${providerOrderId}`,
    ]) {
      const call = fetcher(token, () =>
        Response.json(
          order({ links: [{ rel: "approve", method: "GET", href }] }),
        ),
      );
      await expect(retrieve(config, reference, call)).rejects.toMatchObject({
        code: "invalid_response",
      });
      expect(call).toHaveBeenCalledTimes(2);
    }
  });

  it("freshly checks APPROVED and association before a capture with a distinct stable key", async () => {
    const call = fetcher(
      token,
      () => Response.json(order({ status: "APPROVED", links: [] })),
      () => Response.json(paidOrder()),
    );
    expect(await capture(config, captureInput, call)).toMatchObject({
      status: "COMPLETED",
      approvalUrl: null,
    });
    expect(call.mock.calls.map(([url]) => url)).toEqual([
      `${origin}/v1/oauth2/token`,
      `${origin}/v2/checkout/orders/${providerOrderId}`,
      `${origin}/v2/checkout/orders/${providerOrderId}/capture`,
    ]);
    expect(call.mock.calls[2][1].body).toBe("{}");
    expect(
      new Headers(call.mock.calls[2][1].headers).get("PayPal-Request-Id"),
    ).toBe(captureOperationKey);
    for (const status of [
      "CREATED",
      "PAYER_ACTION_REQUIRED",
      "VOIDED",
      "SAVED",
      "COMPLETED",
    ]) {
      const notApproved = fetcher(token, () =>
        Response.json(order({ status })),
      );
      await expect(
        capture(config, captureInput, notApproved),
      ).rejects.toMatchObject({ code: "reconcile_required" });
      expect(notApproved).toHaveBeenCalledTimes(2);
    }
    const mismatch = fetcher(token, () =>
      Response.json(
        order({
          status: "APPROVED",
          purchase_units: [unit({ custom_id: "wrong" })],
        }),
      ),
    );
    await expect(capture(config, captureInput, mismatch)).rejects.toMatchObject(
      { code: "invalid_response" },
    );
    expect(mismatch).toHaveBeenCalledTimes(2);
    const invalid = fetcher();
    await expect(
      capture(
        config,
        { ...captureInput, captureOperationKey: input.createOperationKey },
        invalid,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      retrieve(config, { ...reference, providerOrderId: "../orders" }, invalid),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(invalid).not.toHaveBeenCalled();
  });

  it("runs the authority fence after provider waits and never mutates if it rejects", async () => {
    const createCall = fetcher(token, () => Response.json(order()));
    const createFence = vi.fn(async () => {
      expect(createCall).toHaveBeenCalledTimes(1);
      throw new Error("Authority revoked");
    });
    await expect(
      create(config, input, createCall, createFence),
    ).rejects.toThrow();
    expect(createFence).toHaveBeenCalledTimes(1);
    expect(createCall.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(
      ["/v1/oauth2/token"],
    );
    const captureCall = fetcher(
      token,
      () => Response.json(order({ status: "APPROVED", links: [] })),
      () => Response.json(paidOrder()),
    );
    const captureFence = vi.fn(async () => {
      expect(captureCall).toHaveBeenCalledTimes(2);
      throw new Error("New attention event");
    });
    await expect(
      capture(config, captureInput, captureCall, captureFence),
    ).rejects.toThrow();
    expect(captureFence).toHaveBeenCalledTimes(1);
    expect(
      captureCall.mock.calls.some(([url]) => url.endsWith("/capture")),
    ).toBe(false);
  });

  it("treats every unverified mutation result as unknown without automatic retry or raw leaks", async () => {
    for (const failure of [
      () => {
        throw new Error(`private upstream ${config.clientSecret}`);
      },
      () => new Response("private upstream", { status: 500 }),
      () => Response.json({ id: providerOrderId, status: "CREATED" }),
      () =>
        Response.json(
          order({
            purchase_units: [unit({ payee: { merchant_id: "BCDEFGHJKLMNP" } })],
          }),
        ),
    ]) {
      for (const kind of ["create", "capture"]) {
        const call =
          kind === "create"
            ? fetcher(token, failure)
            : fetcher(
                token,
                () => Response.json(order({ status: "APPROVED" })),
                failure,
              );
        const error = await (
          kind === "create"
            ? create(config, input, call)
            : capture(config, captureInput, call)
        ).catch((error) => error);
        expect(error).toBeInstanceOf(PayPalSandboxError);
        expect(error).toMatchObject({
          code: "unknown_outcome",
          operationKey:
            kind === "create" ? input.createOperationKey : captureOperationKey,
        });
        expect(error.message).toBe(
          "PayPal test operation could not be verified",
        );
        expect(error.cause).toBeUndefined();
        expect(call).toHaveBeenCalledTimes(kind === "create" ? 2 : 3);
      }
    }
  });

  it("bounds OAuth/results/streams and rejects invalid tokens, HTTP errors and redirects", async () => {
    for (const response of [
      () =>
        Response.json({
          access_token: "x".repeat(4097),
          token_type: "Bearer",
          expires_in: 3600,
        }),
      () =>
        Response.json({
          access_token: "bad\nheader",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      () =>
        Response.json({
          access_token: credential("2"),
          token_type: "Basic",
          expires_in: 3600,
        }),
      () =>
        Response.json({
          access_token: credential("2"),
          token_type: "Bearer",
          expires_in: 0,
        }),
      () => new Response("private", { status: 401 }),
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://evil.invalid" },
        }),
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
    ]) {
      const call = fetcher(response);
      const error = await create(config, input, call).catch((error) => error);
      expect(error).toBeInstanceOf(PayPalSandboxError);
      expect(error.code).not.toBe("unknown_outcome");
      expect(error.message).not.toMatch(/private|bad|131073/);
      expect(call).toHaveBeenCalledTimes(1);
    }
  });

  it("times out OAuth, mutations and body consumption in ten seconds without retry", async () => {
    vi.useFakeTimers();
    for (const phase of ["oauth", "create", "capture", "body"]) {
      const cancel = vi.fn(),
        hanging = () => new Promise<Response>(() => {});
      const call =
        phase === "oauth"
          ? fetcher(hanging)
          : phase === "capture"
            ? fetcher(
                token,
                () => Response.json(order({ status: "APPROVED" })),
                hanging,
              )
            : fetcher(
                token,
                phase === "body"
                  ? () =>
                      new Response(new ReadableStream({ cancel }), {
                        headers: { "Content-Type": "application/json" },
                      })
                  : hanging,
              );
      const result = (
        phase === "capture"
          ? capture(config, captureInput, call)
          : create(config, input, call)
      ).catch((error) => error);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await result).toMatchObject({
        code: phase === "oauth" ? "unavailable" : "unknown_outcome",
      });
      expect(call.mock.calls.at(-1)![1].signal!.aborted).toBe(true);
      if (phase === "body") expect(cancel).toHaveBeenCalledTimes(1);
      expect(call).toHaveBeenCalledTimes(
        phase === "oauth" ? 1 : phase === "capture" ? 3 : 2,
      );
    }
  });
});

describe("canonical PayPal capture facts", () => {
  it("requires completed matching order and fresh full final capture with matching merchant and order", async () => {
    const call = fetcher(
      token,
      () => Response.json(paidOrder()),
      () => Response.json(captured()),
    );
    expect(await facts(config, reference, call)).toEqual({
      captureId,
      providerOrderId,
      amountCents: 4400,
      currency: "CAD",
    });
    expect(call.mock.calls.map(([url]) => url)).toEqual([
      `${origin}/v1/oauth2/token`,
      `${origin}/v2/checkout/orders/${providerOrderId}`,
      `${origin}/v2/payments/captures/${captureId}`,
    ]);
  });
  it("does not use approval or a completed Order containing pending/partial/multiple/refunded captures as funds", async () => {
    for (const changed of [
      { status: "APPROVED" },
      {
        purchase_units: [
          unit({ payments: { captures: [captured({ status: "PENDING" })] } }),
        ],
      },
      {
        purchase_units: [
          unit({
            payments: { captures: [captured({ final_capture: false })] },
          }),
        ],
      },
      {
        purchase_units: [
          unit({
            payments: {
              captures: [captured({ amount: { ...money, value: "43.99" } })],
            },
          }),
        ],
      },
      {
        purchase_units: [
          unit({ payments: { captures: [captured(), captured()] } }),
        ],
      },
      {
        purchase_units: [
          unit({
            payments: {
              captures: [captured()],
              refunds: [{ id: "REFUND123" }],
            },
          }),
        ],
      },
    ]) {
      const call = fetcher(token, () => Response.json(paidOrder(changed)));
      await expect(facts(config, reference, call)).rejects.toBeInstanceOf(
        PayPalSandboxError,
      );
      expect(call).toHaveBeenCalledTimes(2);
    }
  });
  it("rejects canonical capture denial, refund/reversal, wrong amount/currency/merchant/association", async () => {
    for (const changed of [
      { id: "OTHER123" },
      ...[
        "PENDING",
        "DENIED",
        "DECLINED",
        "FAILED",
        "PARTIALLY_REFUNDED",
        "REFUNDED",
        "REVERSED",
      ].map((status) => ({ status })),
      { final_capture: false },
      { amount: { ...money, value: "43.99" } },
      { amount: { ...money, currency_code: "USD" } },
      { payee: { merchant_id: "BCDEFGHJKLMNP" } },
      { supplementary_data: { related_ids: { order_id: "OTHER123" } } },
      { custom_id: "another-instance-attempt-key" },
    ]) {
      const call = fetcher(
        token,
        () => Response.json(paidOrder()),
        () => Response.json(captured(changed)),
      );
      await expect(facts(config, reference, call)).rejects.toBeInstanceOf(
        PayPalSandboxError,
      );
      expect(call).toHaveBeenCalledTimes(3);
    }
  });
});

const webhookId = "ABC123WEBHOOK";
function headers() {
  return new Headers({
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url":
      "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-FICTIONAL123",
    "paypal-transmission-id": "1234abcd-5678-9012-abcd-123456789abc",
    "paypal-transmission-sig": "ZmljdGlvbmFs",
    "paypal-transmission-time": "2026-10-28T12:00:00Z",
  });
}
function event(overrides: Record<string, unknown> = {}) {
  return {
    id: "WH-FICTIONAL-123",
    event_type: "CHECKOUT.ORDER.APPROVED",
    resource: order({ status: "APPROVED" }),
    ...overrides,
  };
}
function verificationInput(value = event(), h = headers()) {
  return {
    webhookId,
    rawBody: new TextEncoder().encode(JSON.stringify(value)),
    headers: h,
  };
}
describe("PayPal real-app webhook postback verification", () => {
  it("posts only to the pinned verification API and emits a minimal same-instance wakeup, never paid", async () => {
    const call = fetcher(token, () =>
      Response.json({ verification_status: "SUCCESS" }),
    );
    expect(await verify(config, verificationInput(), call)).toEqual({
      testOnly: true,
      eventId: "WH-FICTIONAL-123",
      eventType: "CHECKOUT.ORDER.APPROVED",
      providerOrderId,
      captureId: null,
      orderId: input.orderId,
      attemptId: input.attemptId,
      createOperationKey: input.createOperationKey,
    });
    expect(call.mock.calls.map(([url]) => url)).toEqual([
      `${origin}/v1/oauth2/token`,
      `${origin}/v1/notifications/verify-webhook-signature`,
    ]);
    const body = JSON.parse(call.mock.calls[1][1].body as string);
    expect(body).toMatchObject({
      webhook_id: webhookId,
      auth_algo: "SHA256withRSA",
      transmission_id: headers().get("paypal-transmission-id"),
      webhook_event: event(),
    });
    expect(
      new Headers(call.mock.calls[1][1].headers).has("PayPal-Request-Id"),
    ).toBe(false);
  });
  it("never projects another instance's optional order linkage or treats capture events as capture permission", async () => {
    const other = verificationInput(
      event({
        resource: order({
          purchase_units: [
            unit({
              custom_id: customId.replace(
                config.instanceId,
                "66666666-6666-4666-8666-666666666666",
              ),
            }),
          ],
        }),
      }),
    );
    expect(
      await verify(
        config,
        other,
        fetcher(token, () => Response.json({ verification_status: "SUCCESS" })),
      ),
    ).toEqual({
      testOnly: true,
      eventId: "WH-FICTIONAL-123",
      eventType: "CHECKOUT.ORDER.APPROVED",
      providerOrderId,
      captureId: null,
    });
    for (const eventType of [
      "PAYMENT.CAPTURE.COMPLETED",
      "PAYMENT.CAPTURE.PENDING",
      "PAYMENT.CAPTURE.DENIED",
      "PAYMENT.CAPTURE.REVERSED",
    ]) {
      const result = await verify(
        config,
        verificationInput(
          event({ event_type: eventType, resource: captured() }),
        ),
        fetcher(token, () => Response.json({ verification_status: "SUCCESS" })),
      );
      expect(result).toEqual({
        testOnly: true,
        eventId: "WH-FICTIONAL-123",
        eventType,
        providerOrderId,
        captureId,
      });
    }
    expect(
      await verify(
        config,
        verificationInput(
          event({
            event_type: "PAYMENT.CAPTURE.REFUNDED",
            resource: {
              id: "REFUND123",
              supplementary_data: {
                related_ids: {
                  order_id: providerOrderId,
                  capture_id: captureId,
                },
              },
            },
          }),
        ),
        fetcher(token, () => Response.json({ verification_status: "SUCCESS" })),
      ),
    ).toMatchObject({ providerOrderId, captureId });
  });
  it("rejects signature failure; simulator mock support is not invented", async () => {
    for (const verification_status of ["FAILURE", "PENDING", undefined]) {
      const call = fetcher(token, () => Response.json({ verification_status }));
      await expect(
        verify(config, verificationInput(), call),
      ).rejects.toMatchObject({ code: "invalid_signature" });
      expect(call).toHaveBeenCalledTimes(2);
    }
    const call = fetcher();
    await expect(
      verify(config, { ...verificationInput(), webhookId: "WEBHOOK_ID" }, call),
    ).rejects.toMatchObject({ code: "invalid_config" });
    expect(call).not.toHaveBeenCalled();
  });
  it("extracts the original capture from a verified refund up-link without following it or using the refund ID", async () => {
    const call = fetcher(token, () =>
      Response.json({ verification_status: "SUCCESS" }),
    );
    const notification = event({
      event_type: "PAYMENT.CAPTURE.REFUNDED",
      resource: {
        id: "REFUND123",
        links: [
          {
            rel: "up",
            method: "GET",
            href: `https://api-m.paypal.com/v2/payments/captures/${captureId}`,
          },
        ],
      },
    });
    expect(await verify(config, verificationInput(notification), call)).toEqual(
      {
        testOnly: true,
        eventId: "WH-FICTIONAL-123",
        eventType: "PAYMENT.CAPTURE.REFUNDED",
        providerOrderId: null,
        captureId,
      },
    );
    expect(call).toHaveBeenCalledTimes(2);
    const hostile = event({
      event_type: "PAYMENT.CAPTURE.REFUNDED",
      resource: {
        id: "REFUND123",
        links: [
          {
            rel: "up",
            method: "GET",
            href: `https://evil.invalid/v2/payments/captures/${captureId}`,
          },
        ],
      },
    });
    const rejected = fetcher(token, () =>
      Response.json({ verification_status: "SUCCESS" }),
    );
    await expect(
      verify(config, verificationInput(hostile), rejected),
    ).rejects.toMatchObject({ code: "invalid_event" });
    expect(rejected).toHaveBeenCalledTimes(2);
  });
  it("bounds raw events and headers, never fetches arbitrary certificate URLs, and sanitizes provider errors", async () => {
    const call = fetcher();
    for (const cert of [
      "http://169.254.169.254/secrets",
      "https://evil.invalid/cert",
      "https://api.paypal.com/v1/notifications/certs/CERT-123",
      "https://user:pass@api.sandbox.paypal.com/v1/notifications/certs/CERT-123",
    ]) {
      const h = headers();
      h.set("paypal-cert-url", cert);
      await expect(
        verify(config, verificationInput(event(), h), call),
      ).rejects.toMatchObject({ code: "invalid_signature" });
    }
    const missing = headers();
    missing.delete("paypal-transmission-sig");
    await expect(
      verify(config, verificationInput(event(), missing), call),
    ).rejects.toMatchObject({ code: "invalid_signature" });
    await expect(
      verify(
        config,
        { ...verificationInput(), rawBody: new Uint8Array(131073) },
        call,
      ),
    ).rejects.toMatchObject({ code: "invalid_signature" });
    await expect(
      verify(
        config,
        { ...verificationInput(), rawBody: new TextEncoder().encode("{") },
        call,
      ),
    ).rejects.toMatchObject({ code: "invalid_event" });
    await expect(
      verify(
        config,
        verificationInput(event({ event_type: "UNSUPPORTED.EVENT" })),
        call,
      ),
    ).rejects.toMatchObject({ code: "invalid_event" });
    expect(call).not.toHaveBeenCalled();
    const failed = fetcher(token, () => {
      throw new Error(`private ${config.clientSecret}`);
    });
    const error = await verify(config, verificationInput(), failed).catch(
      (error) => error,
    );
    expect(error).toMatchObject({
      code: "unavailable",
      message: "PayPal test operation could not be verified",
    });
    expect(error.cause).toBeUndefined();
  });
});
