/** Explicit-transport, Sandbox-only adapter; no native fetch, DB, card or stock authority.
 * Persist original CREATE/CAPTURE keys and protected inventory before dispatch. A
 * return URL, approval, verified event or completed Order alone is not paid proof.
 * Official contracts checked 2026-10-31:
 * https://developer.paypal.com/api/orders/v2/schema.json
 * https://developer.paypal.com/api/payments/v2/schema.json
 * https://developer.paypal.com/api/rest/authentication/
 * https://developer.paypal.com/api/rest/reference/idempotency/
 * https://developer.paypal.com/api/rest/webhooks/rest/
 */
const ORIGIN = "https://api-m.sandbox.paypal.com";
const LIMIT = 128 * 1024;
const TIMEOUT = 10_000;
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
// Local bounded acceptance subset, compatible with official related_ids schema.
const providerId = /^[A-Z0-9]{1,20}$/;
const merchantId = /^[2-9A-HJ-NP-Z]{13}$/;
export type PayPalSandboxFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;
export type PayPalSandboxConfig = {
  enabled: true;
  mode: "local-test";
  instanceId: string;
  expectedMerchantId: string;
  clientId: string;
  clientSecret: string;
  canonicalOrigin: string;
};
export type PayPalSandboxAssociation = {
  orderId: string;
  attemptId: string;
  createOperationKey: string;
  amountCents: number;
};
export type PayPalSandboxOrder = PayPalSandboxAssociation & {
  testOnly: true;
  providerOrderId: string;
  status:
    | "CREATED"
    | "PAYER_ACTION_REQUIRED"
    | "APPROVED"
    | "COMPLETED"
    | "VOIDED"
    | "SAVED";
  approvalUrl: string | null;
  currency: "CAD";
};
export type PayPalSandboxCapture = {
  captureId: string;
  providerOrderId: string;
  amountCents: number;
  currency: "CAD";
};
export class PayPalSandboxError extends Error {
  constructor(
    public readonly code:
      | "invalid_config"
      | "invalid_request"
      | "unavailable"
      | "account_mismatch"
      | "unknown_outcome"
      | "reconcile_required"
      | "invalid_response"
      | "invalid_signature"
      | "invalid_event",
    public readonly operationKey?: string,
  ) {
    super("PayPal test operation could not be verified");
    this.name = "PayPalSandboxError";
  }
}
function fail(code: PayPalSandboxError["code"]): never {
  throw new PayPalSandboxError(code);
}
function normalize(error: unknown): never {
  if (error instanceof PayPalSandboxError) throw error;
  fail("unavailable");
}
function object(
  value: unknown,
  code: PayPalSandboxError["code"] = "invalid_response",
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value as Record<string, unknown>;
}
function fields(
  value: unknown,
  keys: string[],
  code: PayPalSandboxError["code"],
): Record<string, unknown> {
  const o = object(value, code);
  if (![null, Object.prototype].includes(Object.getPrototypeOf(o))) fail(code);
  const d = Object.getOwnPropertyDescriptors(o);
  if (
    Reflect.ownKeys(o).length !== keys.length ||
    Reflect.ownKeys(o).some((k) => typeof k !== "string" || !keys.includes(k))
  )
    fail(code);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (!d[key] || !("value" in d[key])) fail(code);
    result[key] = d[key].value;
  }
  return result;
}
function match(
  value: unknown,
  pattern: RegExp,
  code: PayPalSandboxError["code"],
): string {
  if (typeof value !== "string" || !pattern.test(value)) fail(code);
  return value;
}
function config(raw: unknown): PayPalSandboxConfig {
  const c = fields(
    raw,
    [
      "enabled",
      "mode",
      "instanceId",
      "expectedMerchantId",
      "clientId",
      "clientSecret",
      "canonicalOrigin",
    ],
    "invalid_config",
  );
  if (c.enabled !== true || c.mode !== "local-test") fail("invalid_config");
  const canonicalOrigin = match(
    c.canonicalOrigin,
    /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/,
    "invalid_config",
  );
  try {
    if (new URL(canonicalOrigin).origin !== canonicalOrigin)
      fail("invalid_config");
  } catch {
    fail("invalid_config");
  }
  return {
    enabled: true,
    mode: "local-test",
    canonicalOrigin,
    instanceId: match(c.instanceId, uuid, "invalid_config"),
    expectedMerchantId: match(
      c.expectedMerchantId,
      merchantId,
      "invalid_config",
    ),
    // Opaque credentials have no universal test prefix. The host enforces Sandbox.
    clientId: match(
      c.clientId,
      /^[\x21-\x39\x3B-\x7E]{16,512}$/,
      "invalid_config",
    ),
    clientSecret: match(
      c.clientSecret,
      /^[\x21-\x7E]{16,512}$/,
      "invalid_config",
    ),
  };
}
const associationKeys = [
  "orderId",
  "attemptId",
  "createOperationKey",
  "amountCents",
];
function association(raw: Record<string, unknown>): PayPalSandboxAssociation {
  const orderId = match(
    raw.orderId,
    /^order-[a-f0-9-]{36}$/,
    "invalid_request",
  );
  match(orderId.slice(6), uuid, "invalid_request");
  if (
    !Number.isSafeInteger(raw.amountCents) ||
    (raw.amountCents as number) < 1 ||
    (raw.amountCents as number) > 99_999_999
  )
    fail("invalid_request");
  return {
    orderId,
    attemptId: match(raw.attemptId, uuid, "invalid_request"),
    createOperationKey: match(raw.createOperationKey, uuid, "invalid_request"),
    amountCents: raw.amountCents as number,
  };
}
function transport(fetcher: unknown): asserts fetcher is PayPalSandboxFetch {
  if (typeof fetcher !== "function") fail("invalid_config");
}
function customId(c: PayPalSandboxConfig, a: PayPalSandboxAssociation) {
  return `local-test:${c.instanceId}:${a.attemptId}:${a.createOperationKey}`;
}
function value(cents: number) {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
function amount(raw: unknown, cents: number) {
  const a = object(raw);
  if (a.currency_code !== "CAD" || a.value !== value(cents))
    fail("invalid_response");
}
async function readJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const length = response.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > LIMIT))
    fail("invalid_response");
  if (
    !response.body ||
    response.headers
      .get("Content-Type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase() !== "application/json"
  )
    fail("invalid_response");
  if (signal.aborted) {
    void response.body.cancel().catch(() => {});
    fail("unavailable");
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIMIT) {
        cancel();
        fail("invalid_response");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  if (signal.aborted) fail("unavailable");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("invalid_response");
  }
}
async function request(
  fetcher: PayPalSandboxFetch,
  path: string,
  authorization: string,
  body?: string,
  operationKey?: string,
  oauth = false,
): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new PayPalSandboxError("unavailable"));
    }, TIMEOUT);
  });
  const work = async () => {
    const response = await fetcher(`${ORIGIN}${path}`, {
      method: body !== undefined ? "POST" : "GET",
      redirect: "error",
      signal: controller.signal,
      headers: {
        Authorization: authorization,
        Accept: "application/json",
        ...(body !== undefined
          ? {
              "Content-Type": oauth
                ? "application/x-www-form-urlencoded"
                : "application/json",
            }
          : {}),
        ...(!oauth ? { Prefer: "return=representation" } : {}),
        ...(operationKey ? { "PayPal-Request-Id": operationKey } : {}),
      },
      ...(body !== undefined ? { body } : {}),
    });
    if (response.status < 200 || response.status >= 300 || response.redirected)
      fail("unavailable");
    return readJson(response, controller.signal);
  };
  try {
    return await Promise.race([work(), timeout]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
async function authorize(
  c: PayPalSandboxConfig,
  fetcher: PayPalSandboxFetch,
): Promise<string> {
  const token = object(
    await request(
      fetcher,
      "/v1/oauth2/token",
      `Basic ${btoa(`${c.clientId}:${c.clientSecret}`)}`,
      "grant_type=client_credentials",
      undefined,
      true,
    ),
  );
  if (
    token.token_type !== "Bearer" ||
    !Number.isSafeInteger(token.expires_in) ||
    (token.expires_in as number) < 1 ||
    typeof token.access_token !== "string" ||
    token.access_token.length > 4096
  )
    fail("invalid_response");
  return `Bearer ${match(token.access_token, /^[A-Za-z0-9\-._~+/]{1,4096}={0,2}$/, "invalid_response")}`;
}
function approval(raw: unknown, id: string): string | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length > 100) fail("invalid_response");
  const links = raw
    .map((item) => object(item))
    .filter((link) => link.rel === "approve" || link.rel === "payer-action");
  if (links.length > 1) fail("invalid_response");
  if (!links.length) return null;
  const l = links[0];
  if (l.method !== "GET" || typeof l.href !== "string" || l.href.length > 4096)
    fail("invalid_response");
  try {
    const url = new URL(l.href);
    if (
      url.origin !== "https://www.sandbox.paypal.com" ||
      url.username ||
      url.password ||
      url.hash ||
      url.searchParams.getAll("token").length !== 1 ||
      url.searchParams.get("token") !== id ||
      !["/checkoutnow", "/app-switch-checkout"].includes(url.pathname)
    )
      fail("invalid_response");
    return l.href;
  } catch {
    fail("invalid_response");
  }
}
function order(
  raw: unknown,
  c: PayPalSandboxConfig,
  a: PayPalSandboxAssociation,
  expectedId?: string,
): { result: PayPalSandboxOrder; unit: Record<string, unknown> } {
  const o = object(raw),
    id = match(o.id, providerId, "invalid_response");
  if (
    (expectedId && id !== expectedId) ||
    o.intent !== "CAPTURE" ||
    ![
      "CREATED",
      "SAVED",
      "APPROVED",
      "VOIDED",
      "COMPLETED",
      "PAYER_ACTION_REQUIRED",
    ].includes(o.status as string) ||
    !Array.isArray(o.purchase_units) ||
    o.purchase_units.length !== 1
  )
    fail("invalid_response");
  const unit = object(o.purchase_units[0]);
  if (unit.reference_id !== a.orderId || unit.custom_id !== customId(c, a))
    fail("invalid_response");
  if (object(unit.payee).merchant_id !== c.expectedMerchantId)
    fail("account_mismatch");
  amount(unit.amount, a.amountCents);
  const url = approval(o.links, id);
  if (["CREATED", "PAYER_ACTION_REQUIRED"].includes(o.status as string) && !url)
    fail("invalid_response");
  return {
    result: {
      testOnly: true,
      providerOrderId: id,
      status: o.status as PayPalSandboxOrder["status"],
      approvalUrl: ["CREATED", "PAYER_ACTION_REQUIRED"].includes(
        o.status as string,
      )
        ? url
        : null,
      ...a,
      currency: "CAD",
    },
    unit,
  };
}
function inputs(
  rawConfig: unknown,
  input: unknown,
  fetcher: PayPalSandboxFetch,
  extra: string[] = [],
) {
  const c = config(rawConfig);
  transport(fetcher);
  const raw = fields(input, [...associationKeys, ...extra], "invalid_request"),
    a = association(raw);
  return { c, raw, a };
}
export async function createPayPalSandboxOrder(
  rawConfig: unknown,
  input: unknown,
  fetcher: PayPalSandboxFetch,
  beforeMutation?: () => Promise<void>,
): Promise<PayPalSandboxOrder> {
  try {
    if (beforeMutation !== undefined && typeof beforeMutation !== "function")
      fail("invalid_request");
    const { c, a } = inputs(rawConfig, input, fetcher),
      auth = await authorize(c, fetcher);
    const body = JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: a.orderId,
          custom_id: customId(c, a),
          description: "Fictional local test order — no real purchase",
          amount: { currency_code: "CAD", value: value(a.amountCents) },
          payee: { merchant_id: c.expectedMerchantId },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            shipping_preference: "NO_SHIPPING",
            user_action: "PAY_NOW",
            payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED",
            return_url: `${c.canonicalOrigin}/checkout/orders/${a.orderId}?paypal_return=success`,
            cancel_url: `${c.canonicalOrigin}/checkout/orders/${a.orderId}?paypal_return=cancel`,
          },
        },
      },
    });
    // Recheck local authority after OAuth/canonical reads, directly before the mutation.
    if (beforeMutation) await beforeMutation();
    try {
      return order(
        await request(
          fetcher,
          "/v2/checkout/orders",
          auth,
          body,
          a.createOperationKey,
        ),
        c,
        a,
      ).result;
    } catch {
      throw new PayPalSandboxError("unknown_outcome", a.createOperationKey);
    }
  } catch (error) {
    normalize(error);
  }
}
export async function retrievePayPalSandboxOrder(
  rawConfig: unknown,
  input: unknown,
  fetcher: PayPalSandboxFetch,
): Promise<PayPalSandboxOrder> {
  try {
    const { c, raw, a } = inputs(rawConfig, input, fetcher, [
        "providerOrderId",
      ]),
      id = match(raw.providerOrderId, providerId, "invalid_request"),
      auth = await authorize(c, fetcher);
    return order(
      await request(fetcher, `/v2/checkout/orders/${id}`, auth),
      c,
      a,
      id,
    ).result;
  } catch (error) {
    normalize(error);
  }
}
export async function capturePayPalSandboxOrder(
  rawConfig: unknown,
  input: unknown,
  fetcher: PayPalSandboxFetch,
  beforeMutation?: () => Promise<void>,
): Promise<PayPalSandboxOrder> {
  try {
    if (beforeMutation !== undefined && typeof beforeMutation !== "function")
      fail("invalid_request");
    const { c, raw, a } = inputs(rawConfig, input, fetcher, [
        "providerOrderId",
        "captureOperationKey",
      ]),
      id = match(raw.providerOrderId, providerId, "invalid_request"),
      key = match(raw.captureOperationKey, uuid, "invalid_request");
    if (key === a.createOperationKey) fail("invalid_request");
    const auth = await authorize(c, fetcher),
      existing = order(
        await request(fetcher, `/v2/checkout/orders/${id}`, auth),
        c,
        a,
        id,
      ).result;
    if (existing.status !== "APPROVED") fail("reconcile_required");
    // Recheck local authority after OAuth/canonical reads, directly before the mutation.
    if (beforeMutation) await beforeMutation();
    try {
      return order(
        await request(
          fetcher,
          `/v2/checkout/orders/${id}/capture`,
          auth,
          "{}",
          key,
        ),
        c,
        a,
        id,
      ).result;
    } catch {
      throw new PayPalSandboxError("unknown_outcome", key);
    }
  } catch (error) {
    normalize(error);
  }
}
function fullCapture(raw: unknown, id: string, cents: number) {
  const capture = object(raw);
  if (
    capture.id !== id ||
    capture.status !== "COMPLETED" ||
    capture.final_capture !== true
  )
    fail("invalid_response");
  amount(capture.amount, cents);
  return capture;
}
/** Extract an ID only. Never follow event-supplied links; actual reads use ORIGIN.
 * Official refund events identify the original capture with an `up` link. */
function captureLink(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length > 100) fail("invalid_event");
  let found: string | null = null;
  for (const item of raw) {
    const link = object(item, "invalid_event");
    if (link.rel !== "up" || link.method !== "GET") continue;
    if (typeof link.href !== "string" || link.href.length > 4096)
      fail("invalid_event");
    try {
      const url = new URL(link.href);
      const result = /^\/v2\/payments\/captures\/([A-Z0-9]{1,20})$/.exec(
        url.pathname,
      );
      if (
        !result ||
        ![
          "https://api-m.sandbox.paypal.com",
          "https://api.sandbox.paypal.com",
          "https://api-m.paypal.com",
          "https://api.paypal.com",
        ].includes(url.origin) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        found
      )
        fail("invalid_event");
      found = result[1];
    } catch {
      fail("invalid_event");
    }
  }
  return found;
}
/** Fresh canonical snapshot only; local allocation still needs an atomic authorized
 * adjudication. PARTIALLY_REFUNDED/REFUNDED/PENDING/DECLINED never authorize paid. */
export async function retrievePayPalSandboxCapture(
  rawConfig: unknown,
  input: unknown,
  fetcher: PayPalSandboxFetch,
): Promise<PayPalSandboxCapture> {
  try {
    const { c, raw, a } = inputs(rawConfig, input, fetcher, [
        "providerOrderId",
      ]),
      id = match(raw.providerOrderId, providerId, "invalid_request"),
      auth = await authorize(c, fetcher);
    const { result, unit } = order(
      await request(fetcher, `/v2/checkout/orders/${id}`, auth),
      c,
      a,
      id,
    );
    if (result.status !== "COMPLETED") fail("reconcile_required");
    const payments = object(unit.payments);
    if (
      !Array.isArray(payments.captures) ||
      payments.captures.length !== 1 ||
      (payments.refunds !== undefined &&
        (!Array.isArray(payments.refunds) || payments.refunds.length !== 0))
    )
      fail("invalid_response");
    const captureId = match(
      object(payments.captures[0]).id,
      providerId,
      "invalid_response",
    );
    fullCapture(payments.captures[0], captureId, a.amountCents);
    const canonical = fullCapture(
      await request(fetcher, `/v2/payments/captures/${captureId}`, auth),
      captureId,
      a.amountCents,
    );
    if (object(canonical.payee).merchant_id !== c.expectedMerchantId)
      fail("account_mismatch");
    if (
      object(object(canonical.supplementary_data).related_ids).order_id !==
        id ||
      (canonical.custom_id !== undefined &&
        canonical.custom_id !== customId(c, a))
    )
      fail("invalid_response");
    return {
      captureId,
      providerOrderId: id,
      amountCents: a.amountCents,
      currency: "CAD",
    };
  } catch (error) {
    normalize(error);
  }
}
export type VerifiedPayPalSandboxEvent = {
  testOnly: true;
  eventId: string;
  eventType: string;
  providerOrderId: string | null;
  captureId: string | null;
  orderId?: string;
  attemptId?: string;
  createOperationKey?: string;
};
/** Postback verification, not certificate fetching or invented HMAC. PayPal's mock
 * webhook simulator does NOT support this method. Events only wake canonical reads;
 * signatures do not grant local ownership, capture permission or stock authority. */
export async function verifyPayPalSandboxWebhook(
  rawConfig: unknown,
  input: unknown,
  fetcher: PayPalSandboxFetch,
): Promise<VerifiedPayPalSandboxEvent> {
  try {
    const c = config(rawConfig);
    transport(fetcher);
    const raw = fields(
      input,
      ["webhookId", "rawBody", "headers"],
      "invalid_request",
    );
    const webhookId = match(
      raw.webhookId,
      /^[A-Za-z0-9]{1,50}$/,
      "invalid_config",
    );
    if (
      !(raw.rawBody instanceof Uint8Array) ||
      raw.rawBody.length === 0 ||
      raw.rawBody.length > LIMIT ||
      !(raw.headers instanceof Headers)
    )
      fail("invalid_signature");
    let event: Record<string, unknown>;
    try {
      event = object(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            new Uint8Array(raw.rawBody),
          ),
        ),
        "invalid_event",
      );
    } catch {
      fail("invalid_event");
    }
    const header = (name: string, pattern: RegExp) =>
      match((raw.headers as Headers).get(name), pattern, "invalid_signature");
    const certUrl = header(
      "paypal-cert-url",
      /^https:\/\/api\.sandbox\.paypal\.com\/v1\/notifications\/certs\/[A-Za-z0-9-]{1,200}$/,
    );
    const verification = {
      auth_algo: header("paypal-auth-algo", /^[A-Za-z0-9]{1,100}$/),
      cert_url: certUrl,
      transmission_id: header(
        "paypal-transmission-id",
        /^(?!\d+$)[A-Za-z0-9_-]{2,50}$/,
      ),
      transmission_sig: header(
        "paypal-transmission-sig",
        /^[A-Za-z0-9+/=]{2,500}$/,
      ),
      transmission_time: header(
        "paypal-transmission-time",
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/,
      ),
      webhook_id: webhookId,
      webhook_event: event,
    };
    if (!Number.isFinite(Date.parse(verification.transmission_time)))
      fail("invalid_signature");
    const eventId = match(event.id, /^[A-Za-z0-9-]{1,100}$/, "invalid_event");
    const eventType = match(
      event.event_type,
      /^(?:CHECKOUT\.ORDER\.(?:APPROVED|COMPLETED)|PAYMENT\.CAPTURE\.(?:COMPLETED|PENDING|DENIED|DECLINED|REFUNDED|REVERSED))$/,
      "invalid_event",
    );
    const resource = object(event.resource, "invalid_event");
    const auth = await authorize(c, fetcher);
    const verified = object(
      await request(
        fetcher,
        "/v1/notifications/verify-webhook-signature",
        auth,
        JSON.stringify(verification),
      ),
    );
    if (verified.verification_status !== "SUCCESS") fail("invalid_signature");
    let providerOrderId: string | null = null,
      captureId: string | null = null;
    const result: VerifiedPayPalSandboxEvent = {
      testOnly: true,
      eventId,
      eventType,
      providerOrderId,
      captureId,
    };
    if (eventType.startsWith("CHECKOUT.ORDER.")) {
      providerOrderId = match(resource.id, providerId, "invalid_event");
      if (
        Array.isArray(resource.purchase_units) &&
        resource.purchase_units.length === 1
      ) {
        const unit = object(resource.purchase_units[0], "invalid_event");
        if (typeof unit.custom_id === "string") {
          const pieces = unit.custom_id.split(":");
          if (
            pieces.length === 4 &&
            pieces[0] === "local-test" &&
            pieces[1] === c.instanceId &&
            uuid.test(pieces[2]) &&
            uuid.test(pieces[3]) &&
            typeof unit.reference_id === "string" &&
            unit.reference_id.startsWith("order-") &&
            uuid.test(unit.reference_id.slice(6))
          ) {
            result.orderId = unit.reference_id;
            result.attemptId = pieces[2];
            result.createOperationKey = pieces[3];
          }
        }
      }
    } else {
      // Refund resources use their own id; only related_ids.capture_id identifies
      // the original capture. Do not mistake a refund ID for captured funds.
      const supplementary =
        resource.supplementary_data === undefined
          ? {}
          : object(resource.supplementary_data, "invalid_event");
      const related =
        supplementary.related_ids === undefined
          ? {}
          : object(supplementary.related_ids, "invalid_event");
      if (related.order_id !== undefined)
        providerOrderId = match(related.order_id, providerId, "invalid_event");
      if (related.capture_id !== undefined)
        captureId = match(related.capture_id, providerId, "invalid_event");
      else if (eventType !== "PAYMENT.CAPTURE.REFUNDED")
        captureId = match(resource.id, providerId, "invalid_event");
      else captureId = captureLink(resource.links);
    }
    return { ...result, providerOrderId, captureId };
  } catch (error) {
    normalize(error);
  }
}
