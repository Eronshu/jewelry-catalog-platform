/** Local-test PayPal transport for the existing order/payment/stock authority.
 * CREATE and explicit CAPTURE each have one durable dispatch boundary. Unknown
 * outcomes are query-only; approval/return/events cannot authorize fulfillment. */
import {
  createPayPalSandboxOrder,
  retrievePayPalSandboxOrder,
  retrievePayPalSandboxCapture,
  type PayPalSandboxConfig,
  type PayPalSandboxFetch,
  type PayPalSandboxAssociation,
  type PayPalSandboxOrder,
  type VerifiedPayPalSandboxEvent,
  capturePayPalSandboxOrder,
} from "./paypal-sandbox.server";

export type OwnedPayPalPayment = {
  state:
    | "not_started"
    | "open"
    | "checking"
    | "paid"
    | "approved"
    | "review_required";
  approvalUrl?: string | null;
  canStart: boolean;
  canQuery: boolean;
  canCapture: boolean;
};
export class OwnedPayPalError extends Error {
  constructor(
    public readonly code:
      | "invalid_config"
      | "invalid_request"
      | "not_found"
      | "unavailable"
      | "conflict",
  ) {
    super("The test payment could not be verified");
    this.name = "OwnedPayPalError";
  }
}
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function fail(code: OwnedPayPalError["code"]): never {
  throw new OwnedPayPalError(code);
}
function fields(
  raw: unknown,
  keys: string[],
  code: OwnedPayPalError["code"],
): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
  )
    fail(code);
  const d = Object.getOwnPropertyDescriptors(raw);
  if (
    Reflect.ownKeys(d).length !== keys.length ||
    Reflect.ownKeys(d).some((k) => typeof k !== "string" || !keys.includes(k))
  )
    fail(code);
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (!d[k] || !("value" in d[k])) fail(code);
    out[k] = d[k].value;
  }
  return out;
}
function text(
  raw: unknown,
  pattern: RegExp,
  code: OwnedPayPalError["code"] = "invalid_request",
): string {
  if (typeof raw !== "string" || !pattern.test(raw)) fail(code);
  return raw;
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
  const origin = text(
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
    instanceId: text(c.instanceId, uuid, "invalid_config"),
    expectedMerchantId: text(
      c.expectedMerchantId,
      /^[2-9A-HJ-NP-Z]{13}$/,
      "invalid_config",
    ),
    clientId: text(
      c.clientId,
      /^[\x21-\x39\x3B-\x7E]{16,512}$/,
      "invalid_config",
    ),
    clientSecret: text(
      c.clientSecret,
      /^[\x21-\x7E]{16,512}$/,
      "invalid_config",
    ),
    canonicalOrigin: origin,
  };
}
function identity(raw: unknown) {
  const i = fields(raw, ["ownerHash", "orderId"], "invalid_request");
  return {
    ownerHash: text(i.ownerHash, /^[a-f0-9]{64}$/),
    orderId: text(
      i.orderId,
      /^order-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    ),
  };
}
function time(clock: () => number): number {
  let n;
  try {
    n = clock();
  } catch {
    fail("invalid_request");
  }
  if (!Number.isSafeInteger(n) || n < 0 || n > 8_639_999_996_400_000)
    fail("invalid_request");
  return n;
}
async function hash(v: unknown) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(v)),
      ),
    ),
  )
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
async function safe<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof OwnedPayPalError) throw e;
    fail("unavailable");
  }
}
type Row = {
  orderId: string;
  ownerHash: string;
  state: string;
  paymentState: string;
  fulfillment: string;
  reserveUntil: number;
  attemptId: string | null;
  requestId: string | null;
  createOperationKey: string | null;
  amountCents: number | null;
  actualMerchantId: string | null;
  canonicalOrigin: string | null;
  captureOperationKey: string | null;
  associationAt: number | null;
  workVersion: number | null;
  claimId: string | null;
  leaseUntil: number | null;
  providerOrderId: string | null;
  providerStatus: string | null;
  approvalUrl: string | null;
  factId: string | null;
  dispatchId: string | null;
  selectedProvider: string | null;
  currentClaimKind: string | null;
  currentWorker: string | null;
  currentStatus: string | null;
  captureReceiptId: string | null;
  attention: number;
};
async function load(
  db: D1Database,
  c: PayPalSandboxConfig,
  i: ReturnType<typeof identity>,
): Promise<Row | null> {
  const r = await db
    .prepare(
      `SELECT o.id AS orderId,o.owner_hash AS ownerHash,o.state,o.payment_state AS paymentState,o.fulfillment,o.reserve_until AS reserveUntil,
 (SELECT provider FROM commerce_payment_attempts WHERE order_id=o.id) AS selectedProvider,
 EXISTS(SELECT 1 FROM commerce_owned_paypal_events e WHERE e.attempt_command_id=a.command_id AND e.event_type IN ('PAYMENT.CAPTURE.REFUNDED','PAYMENT.CAPTURE.REVERSED','PAYMENT.CAPTURE.DENIED','PAYMENT.CAPTURE.DECLINED')) AS attention,
 a.command_id AS attemptId,a.request_id AS requestId,a.create_operation_key AS createOperationKey,a.amount_cents AS amountCents,
 b.actual_merchant_id AS actualMerchantId,b.canonical_origin AS canonicalOrigin,b.capture_operation_key AS captureOperationKey,b.created_at AS associationAt,
 w.version AS workVersion,w.current_claim_id AS claimId,k.lease_until AS leaseUntil,k.kind AS currentClaimKind,k.worker_id AS currentWorker,
 (SELECT status FROM commerce_owned_paypal_status WHERE claim_id=w.current_claim_id) AS currentStatus,
 (SELECT receipt_id FROM commerce_owned_paypal_capture_dispatches WHERE attempt_command_id=a.command_id) AS captureReceiptId,z.provider_order_id AS providerOrderId,
 (SELECT t.status FROM commerce_owned_paypal_status t JOIN commerce_owned_paypal_dispatches d ON d.claim_id=t.claim_id WHERE d.attempt_command_id=a.command_id ORDER BY d.expected_version DESC LIMIT 1) AS providerStatus,
 (SELECT t.approval_url FROM commerce_owned_paypal_status t JOIN commerce_owned_paypal_dispatches d ON d.claim_id=t.claim_id WHERE d.attempt_command_id=a.command_id ORDER BY d.expected_version DESC LIMIT 1) AS approvalUrl,
 (SELECT f.id FROM commerce_payment_capture_facts f WHERE f.attempt_command_id=a.command_id AND f.account_ref=b.actual_merchant_id LIMIT 1) AS factId,
 (SELECT d.claim_id FROM commerce_owned_paypal_dispatches d WHERE d.attempt_command_id=a.command_id AND d.kind='create') AS dispatchId
 FROM commerce_checkout_order_origins x JOIN commerce_orders o ON o.id=x.order_id
 JOIN commerce_payment_scope s ON s.id=1 AND s.mode=x.mode AND s.instance_id=x.instance_id AND s.paypal_account_ref='fixture-paypal'
 LEFT JOIN commerce_payment_attempts a ON a.order_id=o.id AND a.mode=x.mode AND a.instance_id=x.instance_id AND a.owner_hash=x.owner_hash AND a.quote_id=x.promoted_quote_id AND a.rules_version='fictional-checkout-acceptance-v1' AND a.provider='paypal' AND a.account_ref=s.paypal_account_ref
 LEFT JOIN commerce_owned_paypal_associations b ON b.attempt_command_id=a.command_id
 LEFT JOIN commerce_payment_work w ON w.attempt_command_id=a.command_id LEFT JOIN commerce_payment_work_claims k ON k.claim_id=w.current_claim_id
 LEFT JOIN commerce_owned_paypal_orders z ON z.attempt_command_id=a.command_id
 WHERE x.mode=? AND x.instance_id=? AND x.owner_hash=? AND x.order_id=? AND o.owner_hash=x.owner_hash AND o.quote_id=x.promoted_quote_id AND o.reserve_command_id=x.command_id`,
    )
    .bind(c.mode, c.instanceId, i.ownerHash, i.orderId)
    .first<Row>();
  if (
    r?.actualMerchantId &&
    (r.actualMerchantId !== c.expectedMerchantId ||
      r.canonicalOrigin !== c.canonicalOrigin)
  )
    fail("conflict");
  return r;
}
function project(r: Row, now: number): OwnedPayPalPayment {
  const locked = { canStart: false, canQuery: false, canCapture: false };
  if (r.selectedProvider && r.selectedProvider !== "paypal")
    return { state: "review_required", ...locked };
  if (r.attention)
    return {
      state: "review_required",
      ...locked,
      canQuery: !!r.providerOrderId,
    };
  if (
    r.factId &&
    r.state === "confirmed" &&
    r.paymentState === "succeeded" &&
    r.fulfillment === "ready_to_pack"
  )
    return { state: "paid", ...locked };
  if (
    r.state !== "pending_payment" ||
    !["not_started", "processing"].includes(r.paymentState) ||
    r.fulfillment !== "none"
  )
    return { state: "review_required", ...locked };
  if (!r.dispatchId)
    return { state: "not_started", ...locked, canStart: now < r.reserveUntil };
  if (!r.providerOrderId) return { state: "review_required", ...locked };
  if (r.captureReceiptId)
    return { state: "checking", ...locked, canQuery: true };
  if (r.providerStatus === "APPROVED")
    return {
      state: "approved",
      ...locked,
      canQuery: true,
      canCapture:
        r.currentClaimKind === "query" && r.currentStatus === "APPROVED",
    };
  if (["CREATED", "PAYER_ACTION_REQUIRED"].includes(r.providerStatus ?? ""))
    return {
      state: "open",
      ...locked,
      approvalUrl: r.approvalUrl,
      canQuery: true,
    };
  return { state: "checking", ...locked, canQuery: true };
}
export async function readOwnedPayPalPayment(
  db: D1Database,
  rawConfig: PayPalSandboxConfig,
  ownerHash: string,
  orderId: string,
): Promise<OwnedPayPalPayment | null> {
  const c = config(rawConfig),
    i = identity({ ownerHash, orderId });
  return safe(async () => {
    const r = await load(db, c, i);
    return r ? project(r, Date.now()) : null;
  });
}
function association(r: Row): PayPalSandboxAssociation {
  if (!r.attemptId || !r.createOperationKey || !r.amountCents || !r.requestId)
    fail("conflict");
  return {
    orderId: r.orderId,
    attemptId: r.requestId!,
    createOperationKey: r.createOperationKey,
    amountCents: r.amountCents,
  };
}
async function requireRow(
  db: D1Database,
  c: PayPalSandboxConfig,
  i: ReturnType<typeof identity>,
) {
  const r = await load(db, c, i);
  if (!r) fail("not_found");
  return r;
}
async function dispatch(
  db: D1Database,
  r: Row,
  kind: "create" | "query",
  clock: () => number,
) {
  const claimId = crypto.randomUUID(),
    workerId = crypto.randomUUID();
  const requestHash = await hash([
    "owned-paypal-dispatch-v1",
    r.attemptId,
    kind,
    claimId,
    workerId,
    r.workVersion,
  ]);
  const now = time(clock);
  const written = await db
    .prepare(
      `INSERT INTO commerce_owned_paypal_dispatches(claim_id,attempt_command_id,worker_id,request_hash,expected_version,kind,claimed_at) VALUES(?,?,?,?,?,?,?)`,
    )
    .bind(claimId, r.attemptId, workerId, requestHash, r.workVersion, kind, now)
    .run();
  // D1 counts the parent INSERT and its claim/work triggers. A positive ACK
  // alone is insufficient; absent/ambiguous ACK never grants outbound CREATE,
  // even if a later request can see the durable boundary and recover its state.
  if (
    written.success !== true ||
    !Number.isSafeInteger(written.meta?.changes) ||
    written.meta.changes <= 0
  )
    fail("unavailable");
  const claim = { claimId, workerId, requestHash, now };
  if (!(await confirmDispatch(db, r, kind, claim))) fail("unavailable");
  return claim;
}
async function confirmDispatch(
  db: D1Database,
  r: Row,
  kind: "create" | "query",
  claim: {
    claimId: string;
    workerId: string;
    requestHash: string;
    now: number;
  },
): Promise<boolean> {
  const { claimId, workerId, requestHash, now } = claim;
  const confirmed = await db
    .prepare(
      `SELECT d.claim_id AS claimId
   FROM commerce_owned_paypal_dispatches d
   JOIN commerce_payment_work_claims c ON c.claim_id=d.claim_id
   JOIN commerce_payment_work w ON w.attempt_command_id=d.attempt_command_id
   JOIN commerce_payment_attempts a ON a.command_id=d.attempt_command_id
   JOIN commerce_orders o ON o.id=a.order_id
   WHERE o.state='pending_payment' AND o.payment_state='processing' AND o.fulfillment='none'
   AND NOT EXISTS (SELECT 1 FROM commerce_owned_paypal_events e WHERE e.attempt_command_id=a.command_id AND e.event_type IN ('PAYMENT.CAPTURE.REFUNDED','PAYMENT.CAPTURE.REVERSED','PAYMENT.CAPTURE.DENIED','PAYMENT.CAPTURE.DECLINED'))
   AND d.claim_id=? AND d.attempt_command_id=? AND d.worker_id=? AND d.request_hash=?
   AND d.expected_version=? AND d.kind=? AND d.claimed_at=?
   AND c.attempt_command_id=d.attempt_command_id AND c.worker_id=d.worker_id
   AND c.request_hash=d.request_hash AND c.expected_version=d.expected_version
   AND c.kind=d.kind AND c.claimed_at=d.claimed_at AND c.lease_until=d.claimed_at+30000
   AND c.mode=a.mode AND c.instance_id=a.instance_id AND c.provider=a.provider AND c.account_ref=a.account_ref
   AND w.current_claim_id=d.claim_id AND w.version=d.expected_version+1 AND w.next_operation='query'`,
    )
    .bind(claimId, r.attemptId, workerId, requestHash, r.workVersion, kind, now)
    .first<{ claimId: string }>();
  return confirmed?.claimId === claimId;
}

async function saveOrder(
  db: D1Database,
  r: Row,
  s: PayPalSandboxOrder,
  claimId: string | null,
  now: number,
) {
  const existing = await db
    .prepare(
      "SELECT provider_order_id AS id FROM commerce_owned_paypal_orders WHERE attempt_command_id=?",
    )
    .bind(r.attemptId)
    .first<{ id: string }>();
  if (existing && existing.id !== s.providerOrderId) fail("conflict");
  const writes: D1PreparedStatement[] = [];
  if (!existing)
    writes.push(
      db
        .prepare(
          "INSERT INTO commerce_owned_paypal_orders(attempt_command_id,provider_order_id,recorded_at) VALUES(?,?,?)",
        )
        .bind(r.attemptId, s.providerOrderId, now),
    );
  if (claimId)
    writes.push(
      db
        .prepare(
          "INSERT INTO commerce_owned_paypal_status(claim_id,provider_order_id,status,approval_url,recorded_at) VALUES(?,?,?,?,?)",
        )
        .bind(claimId, s.providerOrderId, s.status, s.approvalUrl, now),
    );
  if (writes.length) await db.batch(writes);
}
// Hook errors (e.g. expired/revoked browser session) intentionally preserve their
// typed caller contract. Storage/provider errors never contain secrets or SQL.
async function reauthorize(hook?: () => Promise<void>) {
  if (hook) await hook();
}
export async function startOwnedPayPalPayment(
  db: D1Database,
  rawConfig: PayPalSandboxConfig,
  rawInput: { ownerHash: string; orderId: string },
  fetcher: PayPalSandboxFetch,
  clock: () => number = Date.now,
  beforeDispatch?: () => Promise<void>,
): Promise<OwnedPayPalPayment> {
  const c = config(rawConfig),
    i = identity(rawInput);
  if (typeof fetcher !== "function") fail("invalid_request");
  let r = await safe(() => requireRow(db, c, i));
  if (r.dispatchId || r.factId || r.selectedProvider !== "paypal")
    return project(r, time(clock));
  if (!r.attemptId) fail("conflict");
  await reauthorize(beforeDispatch);
  if (!r.actualMerchantId) {
    const now = time(clock);
    try {
      await db
        .prepare(
          "INSERT INTO commerce_owned_paypal_associations(attempt_command_id,actual_merchant_id,canonical_origin,capture_operation_key,created_at) VALUES(?,?,?,?,?)",
        )
        .bind(
          r.attemptId,
          c.expectedMerchantId,
          c.canonicalOrigin,
          crypto.randomUUID(),
          now,
        )
        .run();
    } catch {
      /* A concurrent same-attempt winner may have committed. */
    }
    r = await safe(() => requireRow(db, c, i));
    if (!r.actualMerchantId) fail("unavailable");
  }
  await reauthorize(beforeDispatch);
  let claim: Awaited<ReturnType<typeof dispatch>>;
  try {
    claim = await dispatch(db, r, "create", clock);
  } catch {
    r = await safe(() => requireRow(db, c, i));
    if (r.dispatchId) return project(r, time(clock));
    fail("unavailable");
  }
  // Never retry CREATE, including when the INSERT response is lost. The next
  // request sees the durable dispatch and can only query a known Session ID.
  await reauthorize(beforeDispatch);
  let session: PayPalSandboxOrder;
  let guardFailed = false,
    guardError: unknown;
  const beforeMutation = async () => {
    try {
      await reauthorize(beforeDispatch);
      if (!(await safe(() => confirmDispatch(db, r, "create", claim))))
        fail("unavailable");
      const current = time(clock);
      if (
        current < claim.now ||
        current >= claim.now + 30000 ||
        current >= r.reserveUntil
      )
        fail("unavailable");
    } catch (error) {
      guardFailed = true;
      guardError = error;
      throw error;
    }
  };
  try {
    session = await createPayPalSandboxOrder(
      c,
      association(r),
      fetcher,
      beforeMutation,
    );
  } catch {
    if (guardFailed) throw guardError;
    return {
      state: "review_required",
      canStart: false,
      canQuery: false,
      canCapture: false,
    };
  }
  await reauthorize(beforeDispatch);
  return safe(async () => {
    try {
      await saveOrder(db, r, session, claim.claimId, time(clock));
    } catch {
      const recovered = await requireRow(db, c, i);
      if (recovered.providerOrderId !== session.providerOrderId)
        fail("unavailable");
    }
    return project(await requireRow(db, c, i), time(clock));
  });
}
export async function reconcileOwnedPayPalPayment(
  db: D1Database,
  rawConfig: PayPalSandboxConfig,
  rawInput: { ownerHash: string; orderId: string },
  fetcher: PayPalSandboxFetch,
  clock: () => number = Date.now,
  beforeDispatch?: () => Promise<void>,
): Promise<OwnedPayPalPayment> {
  const c = config(rawConfig),
    i = identity(rawInput);
  if (typeof fetcher !== "function") fail("invalid_request");
  const r = await safe(() => requireRow(db, c, i));
  if (
    r.factId ||
    r.attention ||
    !r.providerOrderId ||
    r.selectedProvider !== "paypal"
  )
    return project(r, time(clock));
  await reauthorize(beforeDispatch);
  let claim: Awaited<ReturnType<typeof dispatch>>;
  try {
    claim = await dispatch(db, r, "query", clock);
  } catch {
    return safe(async () => project(await requireRow(db, c, i), time(clock)));
  }
  await reauthorize(beforeDispatch);
  const a = { ...association(r), providerOrderId: r.providerOrderId };
  let session: PayPalSandboxOrder;
  try {
    session = await retrievePayPalSandboxOrder(c, a, fetcher);
  } catch {
    return {
      state: "review_required",
      canStart: false,
      canQuery: true,
      canCapture: false,
    };
  }
  await reauthorize(beforeDispatch);
  try {
    await saveOrder(db, r, session, claim.claimId, time(clock));
  } catch {
    fail("unavailable");
  }
  if (session.status !== "COMPLETED")
    return safe(async () => project(await requireRow(db, c, i), time(clock)));
  return finalize(db, c, i, r, claim, fetcher, clock, beforeDispatch);
}
async function finalize(
  db: D1Database,
  c: PayPalSandboxConfig,
  i: ReturnType<typeof identity>,
  r: Row,
  claim: { claimId: string; workerId: string },
  fetcher: PayPalSandboxFetch,
  clock: () => number,
  hook?: () => Promise<void>,
): Promise<OwnedPayPalPayment> {
  const a = { ...association(r), providerOrderId: r.providerOrderId! };
  let capture: Awaited<ReturnType<typeof retrievePayPalSandboxCapture>>;
  try {
    capture = await retrievePayPalSandboxCapture(c, a, fetcher);
  } catch {
    return {
      state: "review_required",
      canStart: false,
      canQuery: true,
      canCapture: false,
    };
  }
  await reauthorize(hook);
  return safe(async () => {
    const payloadHash = await hash([
      "owned-paypal-capture-v1",
      c.instanceId,
      c.expectedMerchantId,
      a,
      capture,
    ]);
    const factId = await hash([
      "owned-paypal-transaction-v1",
      c.instanceId,
      c.expectedMerchantId,
      capture.captureId,
    ]);
    try {
      await db
        .prepare(
          `INSERT INTO commerce_payment_capture_facts(id,attempt_command_id,source_claim_id,source_worker_id,mode,instance_id,provider,account_ref,provider_object_ref,transaction_ref,actual_amount_cents,actual_currency,expected_amount_cents,expected_currency,amount_match,payload_hash,recorded_at,payment_intent_ref) VALUES(?,?,?,?,'local-test',?,'paypal',?,?,?,?,'CAD',?,'CAD','match',?,?,NULL)`,
        )
        .bind(
          factId,
          r.attemptId,
          claim.claimId,
          claim.workerId,
          c.instanceId,
          c.expectedMerchantId,
          r.providerOrderId,
          capture.captureId,
          capture.amountCents,
          r.amountCents,
          payloadHash,
          time(clock),
        )
        .run();
    } catch {
      const after = await requireRow(db, c, i);
      if (!after.factId)
        return {
          state: "review_required",
          canStart: false,
          canQuery: true,
          canCapture: false,
        };
    }
    return project(await requireRow(db, c, i), time(clock));
  });
}
/** Explicit customer-authorized CAPTURE, never called by query/return/event. */
export async function captureOwnedPayPalPayment(
  db: D1Database,
  rawConfig: PayPalSandboxConfig,
  rawInput: { ownerHash: string; orderId: string },
  fetcher: PayPalSandboxFetch,
  clock: () => number = Date.now,
  beforeDispatch?: () => Promise<void>,
): Promise<OwnedPayPalPayment> {
  const c = config(rawConfig),
    i = identity(rawInput);
  if (typeof fetcher !== "function") fail("invalid_request");
  const r = await safe(() => requireRow(db, c, i));
  if (!project(r, time(clock)).canCapture) return project(r, time(clock));
  await reauthorize(beforeDispatch);
  let approved: PayPalSandboxOrder;
  try {
    approved = await retrievePayPalSandboxOrder(
      c,
      { ...association(r), providerOrderId: r.providerOrderId! },
      fetcher,
    );
  } catch {
    return {
      state: "review_required",
      canStart: false,
      canQuery: true,
      canCapture: false,
    };
  }
  const approvedAt = time(clock);
  if (approved.status !== "APPROVED")
    return {
      state: "checking",
      canStart: false,
      canQuery: true,
      canCapture: false,
    };
  await reauthorize(beforeDispatch);
  const receiptId = crypto.randomUUID(),
    recordedAt = time(clock);
  const readReceipt = () =>
    db
      .prepare(
        `SELECT d.receipt_id AS id FROM commerce_owned_paypal_capture_dispatches d
 JOIN commerce_payment_work w ON w.attempt_command_id=d.attempt_command_id
 JOIN commerce_owned_paypal_dispatches q ON q.claim_id=d.source_claim_id
 JOIN commerce_owned_paypal_status s ON s.claim_id=q.claim_id
 JOIN commerce_owned_paypal_associations b ON b.attempt_command_id=d.attempt_command_id
 WHERE d.attempt_command_id=? AND d.receipt_id=? AND d.source_claim_id=? AND d.source_worker_id=?
 AND d.capture_operation_key=? AND d.provider_order_id=? AND d.approved_at=? AND d.recorded_at=?
 AND w.current_claim_id=q.claim_id AND w.version=q.expected_version+1 AND q.kind='query'
 AND q.worker_id=d.source_worker_id AND q.attempt_command_id=d.attempt_command_id AND s.status='APPROVED'
 AND b.capture_operation_key=d.capture_operation_key AND b.actual_merchant_id=? AND b.canonical_origin=?
 AND NOT EXISTS (SELECT 1 FROM commerce_owned_paypal_events e WHERE e.attempt_command_id=d.attempt_command_id AND e.event_type IN ('PAYMENT.CAPTURE.REFUNDED','PAYMENT.CAPTURE.REVERSED','PAYMENT.CAPTURE.DENIED','PAYMENT.CAPTURE.DECLINED'))`,
      )
      .bind(
        r.attemptId,
        receiptId,
        r.claimId,
        r.currentWorker,
        r.captureOperationKey,
        r.providerOrderId,
        approvedAt,
        recordedAt,
        c.expectedMerchantId,
        c.canonicalOrigin,
      )
      .first<{ id: string }>();
  try {
    const written = await db
      .prepare(
        `INSERT INTO commerce_owned_paypal_capture_dispatches(attempt_command_id,receipt_id,source_claim_id,source_worker_id,capture_operation_key,provider_order_id,approved_at,recorded_at) VALUES(?,?,?,?,?,?,?,?)`,
      )
      .bind(
        r.attemptId,
        receiptId,
        r.claimId,
        r.currentWorker,
        r.captureOperationKey,
        r.providerOrderId,
        approvedAt,
        recordedAt,
      )
      .run();
    if (
      written.success !== true ||
      !Number.isSafeInteger(written.meta?.changes) ||
      written.meta.changes !== 1
    )
      fail("unavailable");
    if ((await readReceipt())?.id !== receiptId) fail("unavailable");
  } catch {
    return safe(async () => {
      const after = await requireRow(db, c, i);
      if (!after.captureReceiptId) fail("unavailable");
      return project(after, time(clock));
    });
  }
  await reauthorize(beforeDispatch);
  // No provider mutation after a stale/uncertain receipt/current claim. The
  // consumed original key stays query-only even if authorization/readback fails.
  if (
    (await safe(readReceipt))?.id !== receiptId ||
    time(clock) < recordedAt ||
    time(clock) > approvedAt + 30000
  )
    return {
      state: "review_required",
      canStart: false,
      canQuery: true,
      canCapture: false,
    };
  let guardFailed = false,
    guardError: unknown;
  const beforeMutation = async () => {
    try {
      await reauthorize(beforeDispatch);
      if ((await safe(readReceipt))?.id !== receiptId) fail("unavailable");
      const current = time(clock);
      if (current < recordedAt || current > approvedAt + 30000)
        fail("unavailable");
    } catch (error) {
      guardFailed = true;
      guardError = error;
      throw error;
    }
  };
  try {
    await capturePayPalSandboxOrder(
      c,
      {
        ...association(r),
        providerOrderId: r.providerOrderId!,
        captureOperationKey: r.captureOperationKey!,
      },
      fetcher,
      beforeMutation,
    );
  } catch {
    if (guardFailed) throw guardError;
    return {
      state: "review_required",
      canStart: false,
      canQuery: true,
      canCapture: false,
    };
  }
  await reauthorize(beforeDispatch);
  return finalize(
    db,
    c,
    i,
    r,
    { claimId: r.claimId!, workerId: r.currentWorker! },
    fetcher,
    clock,
    beforeDispatch,
  );
}
/** Verified events are deduplicated wakeups, NEVER capture permission. An order
 * event's decoded reference can recover an unknown CREATE ID only via GET. */
export async function recordOwnedPayPalEvent(
  db: D1Database,
  rawConfig: PayPalSandboxConfig,
  event: VerifiedPayPalSandboxEvent,
  fetcher: PayPalSandboxFetch,
  clock: () => number = Date.now,
): Promise<void> {
  const c = config(rawConfig);
  if (typeof fetcher !== "function") fail("invalid_request");
  if (!event || typeof event !== "object") fail("invalid_request");
  const optional = ["orderId", "attemptId", "createOperationKey"].filter((k) =>
    Object.hasOwn(event, k),
  );
  const e = fields(
    event,
    [
      "testOnly",
      "eventId",
      "eventType",
      "providerOrderId",
      "captureId",
      ...optional,
    ],
    "invalid_request",
  );
  if (e.testOnly !== true) fail("invalid_request");
  const eventId = text(e.eventId, /^[A-Za-z0-9_-]{1,100}$/),
    eventType = text(e.eventType, /^[A-Z._]{1,100}$/);
  let providerOrderId =
    e.providerOrderId === null
      ? null
      : text(e.providerOrderId, /^[A-Z0-9]{1,20}$/);
  const captureId =
    e.captureId === null ? null : text(e.captureId, /^[A-Z0-9]{1,20}$/);
  const orderId =
    e.orderId === undefined ? null : text(e.orderId, /^order-[a-f0-9-]{36}$/);
  const requestId = e.attemptId === undefined ? null : text(e.attemptId, uuid);
  const createKey =
    e.createOperationKey === undefined
      ? null
      : text(e.createOperationKey, uuid);
  if (!providerOrderId && captureId) {
    const linked = await safe(() =>
      db
        .prepare(
          `SELECT f.provider_object_ref AS id FROM commerce_payment_capture_facts f JOIN commerce_owned_paypal_associations b ON b.attempt_command_id=f.attempt_command_id
   WHERE f.mode='local-test' AND f.instance_id=? AND f.provider='paypal' AND f.account_ref=? AND f.transaction_ref=? AND b.actual_merchant_id=f.account_ref AND b.canonical_origin=?`,
        )
        .bind(c.instanceId, c.expectedMerchantId, captureId, c.canonicalOrigin)
        .first<{ id: string }>(),
    );
    providerOrderId = linked?.id ?? null;
  }
  if (!providerOrderId) return;
  const digest = await hash([
    eventId,
    eventType,
    providerOrderId,
    captureId,
    orderId,
    requestId,
    createKey,
  ]);
  await safe(async () => {
    const candidate = await db
      .prepare(
        `SELECT a.owner_hash AS ownerHash,a.order_id AS orderId,a.command_id AS attemptId,a.request_id AS requestId,a.create_operation_key AS createKey
   FROM commerce_payment_attempts a JOIN commerce_owned_paypal_associations b ON b.attempt_command_id=a.command_id
   LEFT JOIN commerce_owned_paypal_orders z ON z.attempt_command_id=a.command_id
   WHERE a.provider='paypal' AND a.mode='local-test' AND a.instance_id=? AND b.actual_merchant_id=? AND b.canonical_origin=?
   AND (z.provider_order_id=? OR (a.request_id=? AND a.order_id=? AND a.create_operation_key=?))`,
      )
      .bind(
        c.instanceId,
        c.expectedMerchantId,
        c.canonicalOrigin,
        providerOrderId,
        requestId,
        orderId,
        createKey,
      )
      .all<{
        ownerHash: string;
        orderId: string;
        attemptId: string;
        requestId: string;
        createKey: string;
      }>();
    if (candidate.results.length !== 1) return;
    const found = candidate.results[0],
      i = identity({ ownerHash: found.ownerHash, orderId: found.orderId }),
      r = await requireRow(db, c, i);
    if (
      !r.dispatchId ||
      (r.providerOrderId && r.providerOrderId !== providerOrderId) ||
      (requestId && requestId !== found.requestId) ||
      (orderId && orderId !== found.orderId) ||
      (createKey && createKey !== found.createKey)
    )
      return;
    const original = await db
      .prepare(
        "SELECT payload_hash AS hash FROM commerce_owned_paypal_events WHERE event_id=? AND attempt_command_id=?",
      )
      .bind(eventId, r.attemptId)
      .first<{ hash: string }>();
    if (original && original.hash !== digest) fail("conflict");
    if (!original) {
      try {
        await db
          .prepare(
            "INSERT INTO commerce_owned_paypal_events(event_id,attempt_command_id,provider_order_id,payload_hash,recorded_at,event_type) VALUES(?,?,?,?,?,?)",
          )
          .bind(
            eventId,
            r.attemptId,
            providerOrderId,
            digest,
            time(clock),
            eventType,
          )
          .run();
      } catch {
        const saved = await db
          .prepare(
            "SELECT payload_hash AS hash FROM commerce_owned_paypal_events WHERE event_id=? AND attempt_command_id=?",
          )
          .bind(eventId, r.attemptId)
          .first<{ hash: string }>();
        if (saved?.hash !== digest) fail("unavailable");
      }
    }
    if (
      [
        "PAYMENT.CAPTURE.REFUNDED",
        "PAYMENT.CAPTURE.REVERSED",
        "PAYMENT.CAPTURE.DENIED",
        "PAYMENT.CAPTURE.DECLINED",
      ].includes(eventType)
    )
      fail("unavailable");
    if (!r.providerOrderId) {
      let observed: PayPalSandboxOrder;
      try {
        observed = await retrievePayPalSandboxOrder(
          c,
          { ...association(r), providerOrderId },
          fetcher,
        );
      } catch {
        fail("unavailable");
      }
      try {
        await saveOrder(db, r, observed, null, time(clock));
      } catch {
        const saved = await requireRow(db, c, i);
        if (saved.providerOrderId !== providerOrderId) fail("unavailable");
      }
    }
    const result = await reconcileOwnedPayPalPayment(db, c, i, fetcher, clock);
    if (!["paid", "approved"].includes(result.state)) fail("unavailable");
  });
}
