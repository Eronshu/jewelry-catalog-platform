/** Isolated full-CAD refund transport. No native fetch, database or local paid/stock authority.
 * Official contracts checked 2026-11-02: https://developer.paypal.com/api/payments/v2/schema.json
 * https://developer.paypal.com/api/orders/v2/schema.json
 * https://developer.paypal.com/api/rest/reference/idempotency/
 * Caller persists the original refund intent/key and grants ONE mutation. Unknown
 * outcomes must use canonical reads, never another financial POST.
 */
import {
  PayPalSandboxError,
  type PayPalSandboxConfig,
  type PayPalSandboxFetch,
} from "./paypal-sandbox.server";
export type PayPalSandboxRefundAssociation = {
  orderId: string;
  attemptId: string;
  createOperationKey: string;
  providerOrderId: string;
  captureId: string;
  amountCents: number;
  refundOperationKey: string;
};
export type PayPalSandboxRefund = {
  refundId: string;
  status: "pending" | "succeeded" | "failed" | "canceled";
  amountCents: number;
  refundedCents: number;
};
const ORIGIN = "https://api-m.sandbox.paypal.com";
const LIMIT = 128 * 1024;
const TIMEOUT = 10_000;
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
// Local bounded acceptance subset, compatible with official related_ids schema.
const providerId = /^[A-Z0-9]{1,20}$/;
const merchantId = /^[2-9A-HJ-NP-Z]{13}$/;
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
function transport(fetcher: unknown): asserts fetcher is PayPalSandboxFetch {
  if (typeof fetcher !== "function") fail("invalid_config");
}
function customId(c: PayPalSandboxConfig, a: PayPalSandboxRefundAssociation) {
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
      // Workers rejects "error" before sending. Reject 3xx below instead of
      // following a redirect that could forward the OAuth/API credentials.
      redirect: "manual",
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

function inputs(
  rawConfig: unknown,
  input: unknown,
  fetcher: PayPalSandboxFetch,
) {
  const c = config(rawConfig);
  transport(fetcher);
  const raw = fields(
    input,
    [
      "orderId",
      "attemptId",
      "createOperationKey",
      "providerOrderId",
      "captureId",
      "amountCents",
      "refundOperationKey",
    ],
    "invalid_request",
  );
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
  const a: PayPalSandboxRefundAssociation = {
    orderId,
    attemptId: match(raw.attemptId, uuid, "invalid_request"),
    createOperationKey: match(raw.createOperationKey, uuid, "invalid_request"),
    providerOrderId: match(raw.providerOrderId, providerId, "invalid_request"),
    captureId: match(raw.captureId, providerId, "invalid_request"),
    amountCents: raw.amountCents as number,
    refundOperationKey: match(raw.refundOperationKey, uuid, "invalid_request"),
  };
  if (
    a.refundOperationKey === a.createOperationKey ||
    a.refundOperationKey === a.attemptId
  )
    fail("invalid_request");
  return { c, a };
}
function refundCustom(
  c: PayPalSandboxConfig,
  a: PayPalSandboxRefundAssociation,
) {
  // Refund custom_id's official response pattern excludes colons.
  return `refund-${c.instanceId}-${a.refundOperationKey}`;
}
function list(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw) || raw.length > 100) fail("invalid_response");
  return raw.map((item) => object(item));
}
function capture(
  raw: unknown,
  a: PayPalSandboxRefundAssociation,
  before: boolean,
) {
  const p = object(raw);
  if (
    p.id !== a.captureId ||
    p.final_capture !== true ||
    !(before ? ["COMPLETED"] : ["COMPLETED", "REFUNDED"]).includes(
      p.status as string,
    )
  )
    fail("reconcile_required");
  amount(p.amount, a.amountCents);
  return p;
}
async function canonical(
  c: PayPalSandboxConfig,
  a: PayPalSandboxRefundAssociation,
  fetcher: PayPalSandboxFetch,
  auth: string,
  before: boolean,
) {
  const order = object(
    await request(fetcher, `/v2/checkout/orders/${a.providerOrderId}`, auth),
  );
  if (
    order.id !== a.providerOrderId ||
    order.intent !== "CAPTURE" ||
    order.status !== "COMPLETED" ||
    !Array.isArray(order.purchase_units) ||
    order.purchase_units.length !== 1
  )
    fail("invalid_response");
  const unit = object(order.purchase_units[0]);
  if (unit.reference_id !== a.orderId || unit.custom_id !== customId(c, a))
    fail("invalid_response");
  if (object(unit.payee).merchant_id !== c.expectedMerchantId)
    fail("account_mismatch");
  amount(unit.amount, a.amountCents);
  const payments = object(unit.payments),
    captures = list(payments.captures);
  if (captures.length !== 1) fail("invalid_response");
  capture(captures[0], a, before);
  const refunds = payments.refunds === undefined ? [] : list(payments.refunds);
  if (before && refunds.length) fail("reconcile_required");
  const p = capture(
    await request(fetcher, `/v2/payments/captures/${a.captureId}`, auth),
    a,
    before,
  );
  if (object(p.payee).merchant_id !== c.expectedMerchantId)
    fail("account_mismatch");
  if (
    object(object(p.supplementary_data).related_ids).order_id !==
      a.providerOrderId ||
    (p.custom_id !== undefined && p.custom_id !== customId(c, a))
  )
    fail("invalid_response");
  // Optional additional evidence cannot contradict the canonical capture state.
  if (p.seller_receivable_breakdown !== undefined) {
    const breakdown = object(p.seller_receivable_breakdown);
    if (breakdown.total_refunded_amount !== undefined)
      amount(
        breakdown.total_refunded_amount,
        before ? 0 : p.status === "REFUNDED" ? a.amountCents : 0,
      );
  }
  return { capture: p, refunds };
}
function refundCaptureLink(raw: unknown, captureId: string) {
  const up = list(raw).filter((link) => link.rel === "up");
  if (
    up.length !== 1 ||
    up[0].method !== "GET" ||
    typeof up[0].href !== "string" ||
    up[0].href.length > 4096
  )
    fail("invalid_response");
  try {
    const url = new URL(up[0].href);
    if (
      ![ORIGIN, "https://api.sandbox.paypal.com"].includes(url.origin) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== `/v2/payments/captures/${captureId}`
    )
      fail("invalid_response");
  } catch {
    fail("invalid_response");
  }
}
function refund(
  raw: unknown,
  c: PayPalSandboxConfig,
  a: PayPalSandboxRefundAssociation,
  id: string,
  captured: Record<string, unknown>,
): PayPalSandboxRefund {
  const r = object(raw);
  if (r.id !== id || r.custom_id !== refundCustom(c, a))
    fail("invalid_response");
  amount(r.amount, a.amountCents);
  refundCaptureLink(r.links, a.captureId);
  if (
    r.payer !== undefined &&
    object(r.payer).merchant_id !== c.expectedMerchantId
  )
    fail("account_mismatch");
  const states = {
    PENDING: "pending",
    COMPLETED: "succeeded",
    FAILED: "failed",
    CANCELLED: "canceled",
  } as const;
  if (typeof r.status !== "string" || !Object.hasOwn(states, r.status))
    fail("invalid_response");
  if (r.seller_payable_breakdown !== undefined) {
    const breakdown = object(r.seller_payable_breakdown);
    if (breakdown.gross_amount !== undefined)
      amount(breakdown.gross_amount, a.amountCents);
    if (breakdown.total_refunded_amount !== undefined)
      amount(
        breakdown.total_refunded_amount,
        r.status === "COMPLETED" ? a.amountCents : 0,
      );
  }
  if (r.status === "COMPLETED" && captured.status !== "REFUNDED")
    fail("reconcile_required");
  if (r.status !== "COMPLETED" && captured.status === "REFUNDED")
    fail("reconcile_required");
  return {
    refundId: id,
    status: states[r.status as keyof typeof states],
    amountCents: a.amountCents,
    refundedCents: r.status === "COMPLETED" ? a.amountCents : 0,
  };
}
/** POST acknowledgment only recovers an ID; it never authorizes local success. */
export async function createPayPalSandboxRefund(
  rawConfig: unknown,
  input: unknown,
  fetcher: PayPalSandboxFetch,
  beforeMutation?: () => Promise<void>,
): Promise<{ refundId: string }> {
  try {
    if (beforeMutation !== undefined && typeof beforeMutation !== "function")
      fail("invalid_request");
    const { c, a } = inputs(rawConfig, input, fetcher),
      auth = await authorize(c, fetcher);
    await canonical(c, a, fetcher, auth, true);
    const body = JSON.stringify({
      amount: { currency_code: "CAD", value: value(a.amountCents) },
      custom_id: refundCustom(c, a),
    });
    if (beforeMutation) await beforeMutation();
    try {
      const result = object(
        await request(
          fetcher,
          `/v2/payments/captures/${a.captureId}/refund`,
          auth,
          body,
          a.refundOperationKey,
        ),
      );
      return { refundId: match(result.id, providerId, "invalid_response") };
    } catch {
      throw new PayPalSandboxError("unknown_outcome", a.refundOperationKey);
    }
  } catch (error) {
    normalize(error);
  }
}
/** Read-only recovery. The OAuth token POST is not a financial mutation. */
export async function retrievePayPalSandboxRefund(
  rawConfig: unknown,
  input: unknown,
  fetcher: PayPalSandboxFetch,
  knownRefundId?: string | null,
): Promise<PayPalSandboxRefund | null> {
  try {
    const { c, a } = inputs(rawConfig, input, fetcher);
    if (knownRefundId !== undefined && knownRefundId !== null)
      match(knownRefundId, providerId, "invalid_request");
    const auth = await authorize(c, fetcher),
      existing = await canonical(c, a, fetcher, auth, false);
    let id = knownRefundId;
    if (!id) {
      if (existing.refunds.length > 1) fail("reconcile_required");
      if (!existing.refunds.length) return null;
      const candidate = existing.refunds[0];
      if (candidate.custom_id !== refundCustom(c, a)) return null;
      amount(candidate.amount, a.amountCents);
      id = match(candidate.id, providerId, "invalid_response");
    }
    // Canonical original Order must not report another or duplicate refund.
    if (
      existing.refunds.some((item) => item.id !== id) ||
      existing.refunds.length > 1
    )
      fail("reconcile_required");
    return refund(
      await request(fetcher, `/v2/payments/refunds/${id}`, auth),
      c,
      a,
      id,
      existing.capture,
    );
  } catch (error) {
    normalize(error);
  }
}
