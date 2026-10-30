/** Offline/injected adapter only: no runtime consumer, default fetch, DB or stock authority.
 * Callers must persist an intent and stable parameters/key BEFORE dispatch, retain holds
 * on uncertainty, and reconcile provider facts against their own authorized order.
 * Stripe's 30min–24h Session expiry is NOT the existing 10min stock deadline.
 */
export const STRIPE_SANDBOX_API_VERSION = "2026-10-28.endive";
const BODY_LIMIT = 128 * 1024;
const TIMEOUT_MS = 10_000;
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sessionIdPattern = /^cs_test_[A-Za-z0-9]{8,240}$/;
const accountPattern = /^acct_[A-Za-z0-9]{8,100}$/;
const encoder = new TextEncoder();
export type StripeSandboxFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;
export type StripeSandboxConfig = {
  enabled: true;
  mode: "local-test";
  instanceId: string;
  expectedAccountId: string;
  testSecretKey: string;
  canonicalOrigin: string;
};
export type StripeSandboxAssociation = {
  orderId: string;
  attemptId: string;
  createOperationKey: string;
  amountCents: number;
  /** Fixed Unix SECONDS, persisted by the caller; never regenerated on retry. */
  sessionExpiresAt: number;
};
export type StripeSandboxSession = {
  testOnly: true;
  sessionId: string;
  status: "open" | "complete" | "expired";
  paymentStatus: "paid" | "unpaid";
  paymentIntentId: string | null;
  hostedUrl: string | null;
  amountCents: number;
  currency: "CAD";
  orderId: string;
  attemptId: string;
  createOperationKey: string;
  sessionExpiresAt: number;
};
export class StripeSandboxError extends Error {
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
    super("Stripe test operation could not be verified");
    this.name = "StripeSandboxError";
  }
}
function fail(code: StripeSandboxError["code"]): never {
  throw new StripeSandboxError(code);
}
/** Read descriptors only: caller getters, prototypes, symbols and extras are not inputs. */
function fields(
  value: unknown,
  keys: string[],
  code: StripeSandboxError["code"],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).length !== keys.length ||
    Reflect.ownKeys(value).some(
      (key) => typeof key !== "string" || !keys.includes(key),
    )
  )
    fail(code);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const d = descriptors[key];
    if (!d || !("value" in d)) fail(code);
    result[key] = d.value;
  }
  return result;
}
function match(
  value: unknown,
  pattern: RegExp,
  code: StripeSandboxError["code"],
): string {
  if (typeof value !== "string" || !pattern.test(value)) fail(code);
  return value;
}
function integer(
  value: unknown,
  min: number,
  max: number,
  code: StripeSandboxError["code"],
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  )
    fail(code);
  return value as number;
}
function seconds(clock: () => number): number {
  let now: unknown;
  try {
    now = clock();
  } catch {
    fail("invalid_request");
  }
  return Math.floor(
    integer(now, 0, 8_640_000_000_000_000, "invalid_request") / 1000,
  );
}
function config(value: unknown): StripeSandboxConfig {
  const c = fields(
    value,
    [
      "enabled",
      "mode",
      "instanceId",
      "expectedAccountId",
      "testSecretKey",
      "canonicalOrigin",
    ],
    "invalid_config",
  );
  if (c.enabled !== true || c.mode !== "local-test") fail("invalid_config");
  const origin = match(
    c.canonicalOrigin,
    /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/,
    "invalid_config",
  );
  try {
    if (new URL(origin).origin !== origin) fail("invalid_config");
  } catch {
    fail("invalid_config");
  }
  return {
    enabled: true,
    mode: "local-test",
    canonicalOrigin: origin,
    instanceId: match(c.instanceId, uuid, "invalid_config"),
    expectedAccountId: match(
      c.expectedAccountId,
      accountPattern,
      "invalid_config",
    ),
    testSecretKey: match(
      c.testSecretKey,
      /^sk_test_[A-Za-z0-9]{16,240}$/,
      "invalid_config",
    ),
  };
}
const associationKeys = [
  "orderId",
  "attemptId",
  "createOperationKey",
  "amountCents",
  "sessionExpiresAt",
];
function association(
  value: Record<string, unknown>,
  code: StripeSandboxError["code"] = "invalid_request",
): StripeSandboxAssociation {
  const orderId = match(value.orderId, /^order-[a-f0-9-]{36}$/, code);
  match(orderId.slice(6), uuid, code);
  return {
    orderId,
    attemptId: match(value.attemptId, uuid, code),
    createOperationKey: match(value.createOperationKey, uuid, code),
    amountCents: integer(value.amountCents, 1, 99_999_999, code),
    sessionExpiresAt: integer(
      value.sessionExpiresAt,
      1,
      8_640_000_000_000,
      code,
    ),
  };
}
function metadata(
  c: Pick<StripeSandboxConfig, "instanceId" | "expectedAccountId">,
  a: StripeSandboxAssociation,
) {
  return {
    test_mode: "local-test",
    instance_id: c.instanceId,
    account_ref: c.expectedAccountId,
    order_id: a.orderId,
    attempt_id: a.attemptId,
    create_operation_key: a.createOperationKey,
  };
}
function object(
  value: unknown,
  code: StripeSandboxError["code"],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value as Record<string, unknown>;
}
function session(
  value: unknown,
  c: Pick<StripeSandboxConfig, "instanceId" | "expectedAccountId">,
  a: StripeSandboxAssociation,
  id?: string,
): StripeSandboxSession {
  const s = object(value, "invalid_response");
  const sessionId = match(s.id, sessionIdPattern, "invalid_response");
  if (
    (id && id !== sessionId) ||
    s.object !== "checkout.session" ||
    s.livemode !== false ||
    s.mode !== "payment" ||
    s.currency !== "cad" ||
    s.amount_total !== a.amountCents ||
    s.client_reference_id !== a.orderId ||
    s.expires_at !== a.sessionExpiresAt ||
    !["open", "complete", "expired"].includes(s.status as string) ||
    !["paid", "unpaid"].includes(s.payment_status as string)
  )
    fail("invalid_response");
  if (
    (s.status === "open" || s.status === "expired") &&
    s.payment_status !== "unpaid"
  )
    fail("invalid_response");
  const paymentIntentId =
    s.payment_intent === null
      ? null
      : match(s.payment_intent, /^pi_[A-Za-z0-9]{8,240}$/, "invalid_response");
  if (s.payment_status === "paid" && paymentIntentId === null)
    fail("invalid_response");
  const meta = object(s.metadata, "invalid_response");
  for (const [key, expected] of Object.entries(metadata(c, a)))
    if (meta[key] !== expected) fail("invalid_response");
  let hostedUrl: string | null = null;
  if (s.url !== null) {
    if (typeof s.url !== "string" || s.url.length > 4096)
      fail("invalid_response");
    try {
      const url = new URL(s.url);
      if (
        url.origin !== "https://checkout.stripe.com" ||
        url.username ||
        url.password ||
        url.protocol !== "https:"
      )
        fail("invalid_response");
      hostedUrl = s.url;
    } catch {
      fail("invalid_response");
    }
  }
  if (s.status === "open" && !hostedUrl) fail("invalid_response");
  return {
    testOnly: true,
    sessionId,
    status: s.status as StripeSandboxSession["status"],
    paymentStatus: s.payment_status as StripeSandboxSession["paymentStatus"],
    paymentIntentId,
    hostedUrl: s.status === "open" ? hostedUrl : null,
    ...a,
    currency: "CAD",
  };
}
async function readJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const length = response.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT))
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
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > BODY_LIMIT) {
        void reader.cancel().catch(() => {});
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
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("invalid_response");
  }
}
/** Timeout also covers body consumption, including a mock transport ignoring abort. */
async function request(
  c: StripeSandboxConfig,
  fetcher: StripeSandboxFetch,
  path: string,
  body?: URLSearchParams,
  key?: string,
): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new StripeSandboxError("unavailable"));
    }, TIMEOUT_MS);
  });
  const work = async () => {
    const response = await fetcher(`https://api.stripe.com${path}`, {
      method: body ? "POST" : "GET",
      redirect: "error",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${c.testSecretKey}`,
        "Stripe-Version": STRIPE_SANDBOX_API_VERSION,
        ...(body
          ? {
              "Content-Type": "application/x-www-form-urlencoded",
              "Idempotency-Key": key!,
            }
          : {}),
      },
      ...(body ? { body: body.toString() } : {}),
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
async function account(c: StripeSandboxConfig, fetcher: StripeSandboxFetch) {
  const a = object(
    await request(c, fetcher, "/v1/account"),
    "invalid_response",
  );
  if (a.object !== "account" || a.id !== c.expectedAccountId)
    fail("account_mismatch");
  // Account objects do not have a universal livemode field; session checks below do.
}
function transport(fetcher: unknown): asserts fetcher is StripeSandboxFetch {
  if (typeof fetcher !== "function") fail("invalid_config");
}
function normalize(error: unknown): never {
  if (error instanceof StripeSandboxError) throw error;
  fail("unavailable");
}
export async function createStripeSandboxSession(
  rawConfig: unknown,
  input: unknown,
  fetcher: StripeSandboxFetch,
  clock: () => number = Date.now,
): Promise<StripeSandboxSession> {
  try {
    const c = config(rawConfig);
    transport(fetcher);
    const a = association(fields(input, associationKeys, "invalid_request"));
    const assertExpiry = () => {
      const remaining = a.sessionExpiresAt - seconds(clock);
      if (remaining < 1800)
        throw new StripeSandboxError(
          "reconcile_required",
          a.createOperationKey,
        );
      if (remaining > 86400) fail("invalid_request");
    };
    assertExpiry();
    const body = new URLSearchParams({
      mode: "payment",
      "payment_method_types[0]": "card",
      "adaptive_pricing[enabled]": "false",
      currency: "cad",
      client_reference_id: a.orderId,
      success_url: `${c.canonicalOrigin}/checkout/orders/${a.orderId}?stripe_return=success`,
      cancel_url: `${c.canonicalOrigin}/checkout/orders/${a.orderId}?stripe_return=cancel`,
      expires_at: String(a.sessionExpiresAt),
      "line_items[0][price_data][currency]": "cad",
      "line_items[0][price_data][unit_amount]": String(a.amountCents),
      "line_items[0][price_data][product_data][name]":
        "Fictional test order — no real purchase",
      "line_items[0][quantity]": "1",
    });
    for (const [key, value] of Object.entries(metadata(c, a)))
      body.set(`metadata[${key}]`, value);
    await account(c, fetcher);
    assertExpiry();
    try {
      // A retry can return a previously completed Session: never require "open" here.
      return session(
        await request(
          c,
          fetcher,
          "/v1/checkout/sessions",
          body,
          a.createOperationKey,
        ),
        c,
        a,
      );
    } catch {
      throw new StripeSandboxError("unknown_outcome", a.createOperationKey);
    }
  } catch (error) {
    normalize(error);
  }
}
export async function retrieveStripeSandboxSession(
  rawConfig: unknown,
  input: unknown,
  fetcher: StripeSandboxFetch,
): Promise<StripeSandboxSession> {
  try {
    const c = config(rawConfig);
    transport(fetcher);
    const raw = fields(
      input,
      [...associationKeys, "sessionId"],
      "invalid_request",
    );
    const a = association(raw),
      id = match(raw.sessionId, sessionIdPattern, "invalid_request");
    await account(c, fetcher);
    return session(
      await request(c, fetcher, `/v1/checkout/sessions/${id}`),
      c,
      a,
      id,
    );
  } catch (error) {
    normalize(error);
  }
}
export async function expireStripeSandboxSession(
  rawConfig: unknown,
  input: unknown,
  fetcher: StripeSandboxFetch,
): Promise<StripeSandboxSession> {
  try {
    const c = config(rawConfig);
    transport(fetcher);
    const raw = fields(
      input,
      [...associationKeys, "sessionId", "expireOperationKey"],
      "invalid_request",
    );
    const a = association(raw),
      id = match(raw.sessionId, sessionIdPattern, "invalid_request"),
      key = match(raw.expireOperationKey, uuid, "invalid_request");
    if (key === a.createOperationKey) fail("invalid_request");
    await account(c, fetcher);
    // Check association before mutation: never expire an arbitrary supplied Session ID.
    const existing = session(
      await request(c, fetcher, `/v1/checkout/sessions/${id}`),
      c,
      a,
      id,
    );
    if (existing.status === "expired") return existing;
    if (existing.status !== "open")
      throw new StripeSandboxError("reconcile_required", key);
    try {
      const result = session(
        await request(
          c,
          fetcher,
          `/v1/checkout/sessions/${id}/expire`,
          new URLSearchParams(),
          key,
        ),
        c,
        a,
        id,
      );
      if (result.status !== "expired") fail("invalid_response");
      return result;
    } catch {
      throw new StripeSandboxError("unknown_outcome", key);
    }
  } catch (error) {
    normalize(error);
  }
}
export type StripeSandboxWebhookConfig = {
  enabled: true;
  mode: "local-test";
  instanceId: string;
  expectedAccountId: string;
  signingSecrets: readonly string[];
};
export type VerifiedStripeSandboxEvent = {
  testOnly: true;
  eventId: string;
  eventType: string;
  apiVersion: typeof STRIPE_SANDBOX_API_VERSION;
  createdAt: number;
  /** Signature scope is configured, NOT proof of local order ownership or payment. */
  session: StripeSandboxSession;
};
/** No replay persistence. Ordinary direct-account events may omit account. A secret's
 * real account binding requires operator verification; consumers MUST retrieve and
 * compare canonical provider/local order facts before any payment/stock transition. */
export async function verifyStripeSandboxWebhook(
  rawConfig: unknown,
  rawBody: Uint8Array,
  signature: unknown,
  clock: () => number = Date.now,
): Promise<VerifiedStripeSandboxEvent> {
  try {
    const c = fields(
      rawConfig,
      ["enabled", "mode", "instanceId", "expectedAccountId", "signingSecrets"],
      "invalid_config",
    );
    if (c.enabled !== true || c.mode !== "local-test") fail("invalid_config");
    const scope = {
      instanceId: match(c.instanceId, uuid, "invalid_config"),
      expectedAccountId: match(
        c.expectedAccountId,
        accountPattern,
        "invalid_config",
      ),
    };
    const rawSecrets = c.signingSecrets;
    if (
      !Array.isArray(rawSecrets) ||
      rawSecrets.length < 1 ||
      rawSecrets.length > 2 ||
      Reflect.ownKeys(rawSecrets).length !== rawSecrets.length + 1
    )
      fail("invalid_config");
    const secrets: string[] = [];
    for (let i = 0; i < rawSecrets.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(rawSecrets, String(i));
      if (!descriptor || !("value" in descriptor)) fail("invalid_config");
      secrets.push(
        match(
          descriptor.value,
          /^whsec_[A-Za-z0-9]{16,240}$/,
          "invalid_config",
        ),
      );
    }
    if (
      !(rawBody instanceof Uint8Array) ||
      rawBody.byteLength === 0 ||
      rawBody.byteLength > BODY_LIMIT
    )
      fail("invalid_signature");
    const bytes = new Uint8Array(rawBody);
    if (typeof signature !== "string" || signature.length > 4096)
      fail("invalid_signature");
    let timestamp: string | undefined;
    const signatures: Uint8Array<ArrayBuffer>[] = [];
    for (const part of signature.split(",")) {
      const pair = part.trim().split("=");
      if (pair.length !== 2) fail("invalid_signature");
      if (pair[0] === "t") {
        if (timestamp !== undefined || !/^[1-9][0-9]{0,12}$/.test(pair[1]))
          fail("invalid_signature");
        timestamp = pair[1];
      } else if (pair[0] === "v1" || pair[0] === "v0") {
        if (!/^[a-f0-9]{64}$/.test(pair[1])) fail("invalid_signature");
        if (pair[0] === "v1")
          signatures.push(
            Uint8Array.from(pair[1].match(/../g)!, (hex) => parseInt(hex, 16)),
          );
      } else fail("invalid_signature");
    }
    if (!timestamp || !signatures.length || signatures.length > 4)
      fail("invalid_signature");
    const assertTime = () => {
      if (Math.abs(seconds(clock) - Number(timestamp)) > 300)
        fail("invalid_signature");
    };
    assertTime();
    const prefix = encoder.encode(`${timestamp}.`),
      signed = new Uint8Array(prefix.length + bytes.length);
    signed.set(prefix);
    signed.set(bytes, prefix.length);
    let verified = false;
    for (const secret of secrets) {
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      for (const digest of signatures)
        verified =
          (await crypto.subtle.verify("HMAC", key, digest, signed)) || verified;
    }
    if (!verified) fail("invalid_signature");
    assertTime();
    let payload: unknown;
    try {
      payload = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      fail("invalid_event");
    }
    const e = object(payload, "invalid_event");
    const eventId = match(e.id, /^evt_[A-Za-z0-9]{8,240}$/, "invalid_event");
    if (
      e.object !== "event" ||
      e.livemode !== false ||
      e.api_version !== STRIPE_SANDBOX_API_VERSION ||
      (e.account !== undefined && e.account !== scope.expectedAccountId) ||
      ![
        "checkout.session.completed",
        "checkout.session.expired",
        "checkout.session.async_payment_succeeded",
        "checkout.session.async_payment_failed",
      ].includes(e.type as string)
    )
      fail("invalid_event");
    const createdAt = integer(e.created, 1, 8_640_000_000_000, "invalid_event");
    const s = object(object(e.data, "invalid_event").object, "invalid_event"),
      m = object(s.metadata, "invalid_event");
    const a = association(
      {
        orderId: m.order_id,
        attemptId: m.attempt_id,
        createOperationKey: m.create_operation_key,
        amountCents: s.amount_total,
        sessionExpiresAt: s.expires_at,
      },
      "invalid_event",
    );
    let projection: StripeSandboxSession;
    try {
      projection = session(s, scope, a);
    } catch {
      fail("invalid_event");
    }
    if (
      (e.type === "checkout.session.expired" &&
        projection.status !== "expired") ||
      (e.type !== "checkout.session.expired" &&
        projection.status !== "complete") ||
      (e.type === "checkout.session.async_payment_succeeded" &&
        projection.paymentStatus !== "paid") ||
      (e.type === "checkout.session.async_payment_failed" &&
        projection.paymentStatus !== "unpaid")
    )
      fail("invalid_event");
    return {
      testOnly: true,
      eventId,
      eventType: e.type as string,
      apiVersion: STRIPE_SANDBOX_API_VERSION,
      createdAt,
      session: projection,
    };
  } catch (error) {
    normalize(error);
  }
}
