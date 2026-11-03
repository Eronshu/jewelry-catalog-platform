import {
  STRIPE_SANDBOX_API_VERSION,
  StripeSandboxError,
  type StripeSandboxConfig,
  type StripeSandboxFetch,
} from "./stripe-sandbox.server";
const BODY_LIMIT = 128 * 1024;
const TIMEOUT_MS = 10_000;
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const accountPattern = /^acct_[A-Za-z0-9]{8,100}$/;
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
function object(
  value: unknown,
  code: StripeSandboxError["code"],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value as Record<string, unknown>;
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
      // Workers rejects "error" before sending. Manual keeps credentials on the
      // fixed host; the non-2xx check below rejects redirects without following.
      redirect: "manual",
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
/** These are persisted original values, never accepted from a browser. */
export type StripeSandboxRefundAssociation = {
  orderId: string;
  paymentRequestId: string;
  createOperationKey: string;
  requestId: string;
  operationKey: string;
  captureId: string;
  chargeId: string;
  paymentIntentId: string;
  /** Original captured total. Omit both optional fields for saved full refunds. */
  amountCents: number;
  /** Paired fields: this request's cents and the previously confirmed total. */
  refundCents?: number;
  expectedRefundedCents?: number;
};
export type StripeSandboxRefund = {
  refundId: string;
  status: "pending" | "requires_action" | "succeeded" | "failed" | "canceled";
  amountCents: number;
  refundedCents: number;
};
const refundKeys = [
  "orderId",
  "paymentRequestId",
  "createOperationKey",
  "requestId",
  "operationKey",
  "captureId",
  "chargeId",
  "paymentIntentId",
  "amountCents",
];
function refundAssociation(raw: unknown): StripeSandboxRefundAssociation {
  const partial =
    raw !== null &&
    typeof raw === "object" &&
    (Object.hasOwn(raw, "refundCents") ||
      Object.hasOwn(raw, "expectedRefundedCents"));
  const a = fields(
    raw,
    partial
      ? [...refundKeys, "refundCents", "expectedRefundedCents"]
      : refundKeys,
    "invalid_request",
  );
  const orderId = match(a.orderId, /^order-[a-f0-9-]{36}$/, "invalid_request");
  match(orderId.slice(6), uuid, "invalid_request");
  const requestId = match(a.requestId, uuid, "invalid_request");
  if (a.operationKey !== requestId) fail("invalid_request");
  const amountCents = integer(a.amountCents, 1, 99999999, "invalid_request");
  let amounts: Pick<
    StripeSandboxRefundAssociation,
    "refundCents" | "expectedRefundedCents"
  > = {};
  if (partial) {
    const refundCents = integer(
      a.refundCents,
      1,
      amountCents,
      "invalid_request",
    );
    const expectedRefundedCents = integer(
      a.expectedRefundedCents,
      0,
      amountCents - refundCents,
      "invalid_request",
    );
    amounts = { refundCents, expectedRefundedCents };
  }
  return {
    orderId,
    requestId,
    operationKey: requestId,
    paymentRequestId: match(a.paymentRequestId, uuid, "invalid_request"),
    createOperationKey: match(a.createOperationKey, uuid, "invalid_request"),
    captureId: match(a.captureId, /^[a-f0-9]{64}$/, "invalid_request"),
    chargeId: match(a.chargeId, /^ch_[A-Za-z0-9]{8,240}$/, "invalid_request"),
    paymentIntentId: match(
      a.paymentIntentId,
      /^pi_[A-Za-z0-9]{8,240}$/,
      "invalid_request",
    ),
    amountCents,
    ...amounts,
  };
}
function paymentMetadata(
  c: StripeSandboxConfig,
  a: StripeSandboxRefundAssociation,
) {
  return {
    test_mode: "local-test",
    instance_id: c.instanceId,
    account_ref: c.expectedAccountId,
    order_id: a.orderId,
    attempt_id: a.paymentRequestId,
    create_operation_key: a.createOperationKey,
  };
}
function refundMetadata(
  c: StripeSandboxConfig,
  a: StripeSandboxRefundAssociation,
): Record<string, string> {
  return {
    ...paymentMetadata(c, a),
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
  };
}
function verifyMetadata(value: unknown, expected: Record<string, string>) {
  const m = object(value, "invalid_response");
  for (const [k, v] of Object.entries(expected))
    if (m[k] !== v) fail("invalid_response");
}
async function charge(
  c: StripeSandboxConfig,
  a: StripeSandboxRefundAssociation,
  fetcher: StripeSandboxFetch,
  before: boolean,
) {
  const pi = object(
    await request(c, fetcher, `/v1/payment_intents/${a.paymentIntentId}`),
    "invalid_response",
  );
  if (
    pi.id !== a.paymentIntentId ||
    pi.object !== "payment_intent" ||
    pi.livemode !== false ||
    pi.status !== "succeeded" ||
    pi.currency !== "cad" ||
    pi.amount !== a.amountCents ||
    pi.amount_received !== a.amountCents ||
    pi.amount_capturable !== 0 ||
    pi.latest_charge !== a.chargeId
  )
    fail("invalid_response");
  verifyMetadata(pi.metadata, paymentMetadata(c, a));
  const ch = object(
    await request(c, fetcher, `/v1/charges/${a.chargeId}`),
    "invalid_response",
  );
  if (
    ch.id !== a.chargeId ||
    ch.object !== "charge" ||
    ch.payment_intent !== a.paymentIntentId ||
    ch.livemode !== false ||
    ch.status !== "succeeded" ||
    ch.paid !== true ||
    ch.captured !== true ||
    ch.currency !== "cad" ||
    ch.amount !== a.amountCents ||
    ch.amount_captured !== a.amountCents ||
    ch.disputed !== false
  )
    fail("invalid_response");
  const refunded = integer(
    ch.amount_refunded,
    0,
    a.amountCents,
    "invalid_response",
  );
  if (
    ch.refunded !== (refunded === a.amountCents) ||
    (before && refunded !== (a.expectedRefundedCents ?? 0))
  )
    fail("invalid_response");
  return refunded;
}
function refund(
  raw: unknown,
  c: StripeSandboxConfig,
  a: StripeSandboxRefundAssociation,
  refundedCents: number,
  expectedId?: string,
): StripeSandboxRefund {
  const r = object(raw, "invalid_response"),
    id = match(r.id, /^re_[A-Za-z0-9]{8,240}$/, "invalid_response");
  if (
    (expectedId && expectedId !== id) ||
    r.object !== "refund" ||
    (r.livemode !== undefined && r.livemode !== false) ||
    r.charge !== a.chargeId ||
    r.payment_intent !== a.paymentIntentId ||
    r.currency !== "cad" ||
    r.amount !== (a.refundCents ?? a.amountCents) ||
    !["pending", "requires_action", "succeeded", "failed", "canceled"].includes(
      r.status as string,
    )
  )
    fail("invalid_response");
  verifyMetadata(r.metadata, refundMetadata(c, a));
  if (
    r.status === "succeeded" &&
    refundedCents !==
      (a.expectedRefundedCents ?? 0) + (a.refundCents ?? a.amountCents)
  )
    fail("invalid_response");
  return {
    refundId: id,
    status: r.status as StripeSandboxRefund["status"],
    amountCents: a.amountCents,
    refundedCents:
      a.refundCents === undefined
        ? refundedCents
        : r.status === "succeeded"
          ? a.refundCents
          : 0,
  };
}
/** Exactly one POST, authorized by the caller's durable dispatch acknowledgment.
 * The hook runs AFTER account/PI/charge reads and immediately before mutation. */
export async function createStripeSandboxRefund(
  rawConfig: StripeSandboxConfig,
  rawInput: StripeSandboxRefundAssociation,
  fetcher: StripeSandboxFetch,
  beforeMutation: () => Promise<void>,
): Promise<string> {
  try {
    const c = config(rawConfig),
      a = refundAssociation(rawInput);
    transport(fetcher);
    if (typeof beforeMutation !== "function") fail("invalid_request");
    await account(c, fetcher);
    await charge(c, a, fetcher, true);
    await beforeMutation();
    const body = new URLSearchParams({
      charge: a.chargeId,
      amount: String(a.refundCents ?? a.amountCents),
    });
    for (const [k, v] of Object.entries(refundMetadata(c, a)))
      body.set(`metadata[${k}]`, v);
    try {
      const r = object(
        await request(c, fetcher, "/v1/refunds", body, a.operationKey),
        "invalid_response",
      );
      // A POST response can only recover an ID; it never proves a refunded payment.
      return match(r.id, /^re_[A-Za-z0-9]{8,240}$/, "invalid_response");
    } catch {
      throw new StripeSandboxError("unknown_outcome", a.operationKey);
    }
  } catch (error) {
    normalize(error);
  }
}
/** Fresh account/PI/charge/refund reads. Lost IDs use at most three pages of 100.
 * Any ambiguous or incomplete list stays manual review under the original key. */
export async function retrieveStripeSandboxRefund(
  rawConfig: StripeSandboxConfig,
  rawInput: StripeSandboxRefundAssociation,
  fetcher: StripeSandboxFetch,
  knownId: string | null = null,
): Promise<StripeSandboxRefund> {
  try {
    const c = config(rawConfig),
      a = refundAssociation(rawInput);
    transport(fetcher);
    if (knownId !== null)
      match(knownId, /^re_[A-Za-z0-9]{8,240}$/, "invalid_request");
    await account(c, fetcher);
    const refunded = await charge(c, a, fetcher, false);
    let id = knownId;
    if (!id) {
      let cursor: string | null = null,
        complete = false;
      const matches = new Set<string>();
      for (let page = 0; page < 3; page++) {
        const params = new URLSearchParams({
          charge: a.chargeId,
          limit: "100",
        });
        if (cursor) params.set("starting_after", cursor);
        const list = object(
          await request(c, fetcher, `/v1/refunds?${params}`),
          "invalid_response",
        );
        if (
          list.object !== "list" ||
          !Array.isArray(list.data) ||
          list.data.length > 100 ||
          typeof list.has_more !== "boolean"
        )
          fail("invalid_response");
        for (const raw of list.data) {
          const r = object(raw, "invalid_response");
          const meta = object(r.metadata, "invalid_response");
          // Ignore unrelated refunds, but a candidate must match ALL originals.
          if (
            meta.refund_operation_key === a.operationKey ||
            meta.refund_request_id === a.requestId
          )
            matches.add(refund(r, c, a, refunded).refundId);
        }
        if (!list.has_more) {
          complete = true;
          break;
        }
        if (!list.data.length) fail("invalid_response");
        const next = match(
          object(list.data.at(-1), "invalid_response").id,
          /^re_[A-Za-z0-9]{8,240}$/,
          "invalid_response",
        );
        if (next === cursor) fail("invalid_response");
        cursor = next;
      }
      if (!complete || matches.size !== 1) fail("reconcile_required");
      id = [...matches][0];
    }
    return refund(
      await request(c, fetcher, `/v1/refunds/${id}`),
      c,
      a,
      refunded,
      id,
    );
  } catch (error) {
    normalize(error);
  }
}
