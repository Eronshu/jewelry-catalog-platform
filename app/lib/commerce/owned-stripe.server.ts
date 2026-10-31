/** Local-test transport glue for the ONE canonical order/payment/stock root.
 * A dispatch record prevents CREATE replay even after a lost response. Only a
 * canonical Session + PI + Charge read can supply a capture fact. No native fetch.
 */
import {
  createStripeSandboxSession,
  retrieveStripeSandboxSession,
  retrieveStripeSandboxCapture,
  STRIPE_SANDBOX_API_VERSION,
  type StripeSandboxConfig,
  type StripeSandboxFetch,
  type StripeSandboxAssociation,
  type StripeSandboxSession,
  type VerifiedStripeSandboxEvent,
} from "./stripe-sandbox.server";

export type OwnedStripePayment = {
  state:
    | "not_started"
    | "open"
    | "checking"
    | "paid"
    | "expired"
    | "review_required";
  hostedUrl?: string | null;
  canStart: boolean;
  canQuery: boolean;
};
export class OwnedStripeError extends Error {
  constructor(
    public readonly code:
      | "invalid_config"
      | "invalid_request"
      | "not_found"
      | "unavailable"
      | "conflict",
  ) {
    super("The test payment could not be verified");
    this.name = "OwnedStripeError";
  }
}
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function fail(code: OwnedStripeError["code"]): never {
  throw new OwnedStripeError(code);
}
function fields(
  raw: unknown,
  keys: string[],
  code: OwnedStripeError["code"],
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
  code: OwnedStripeError["code"] = "invalid_request",
): string {
  if (typeof raw !== "string" || !pattern.test(raw)) fail(code);
  return raw;
}
function config(raw: unknown): StripeSandboxConfig {
  const c = fields(
    raw,
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
    expectedAccountId: text(
      c.expectedAccountId,
      /^acct_[A-Za-z0-9]{8,100}$/,
      "invalid_config",
    ),
    testSecretKey: text(
      c.testSecretKey,
      /^sk_test_[A-Za-z0-9]{16,240}$/,
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
    if (e instanceof OwnedStripeError) throw e;
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
  actualAccountId: string | null;
  canonicalOrigin: string | null;
  sessionExpiresAt: number | null;
  associationAt: number | null;
  workVersion: number | null;
  claimId: string | null;
  leaseUntil: number | null;
  sessionId: string | null;
  sessionStatus: string | null;
  hostedUrl: string | null;
  factId: string | null;
  dispatchId: string | null;
};
async function load(
  db: D1Database,
  c: StripeSandboxConfig,
  i: ReturnType<typeof identity>,
): Promise<Row | null> {
  const r = await db
    .prepare(
      `SELECT o.id AS orderId,o.owner_hash AS ownerHash,o.state,o.payment_state AS paymentState,o.fulfillment,o.reserve_until AS reserveUntil,
 a.command_id AS attemptId,a.request_id AS requestId,a.create_operation_key AS createOperationKey,a.amount_cents AS amountCents,
 b.actual_account_id AS actualAccountId,b.canonical_origin AS canonicalOrigin,b.session_expires_at AS sessionExpiresAt,b.created_at AS associationAt,
 w.version AS workVersion,w.current_claim_id AS claimId,k.lease_until AS leaseUntil,z.session_id AS sessionId,
 (SELECT t.status FROM commerce_owned_stripe_status t JOIN commerce_owned_stripe_dispatches d ON d.claim_id=t.claim_id WHERE d.attempt_command_id=a.command_id ORDER BY d.expected_version DESC LIMIT 1) AS sessionStatus,
 (SELECT t.hosted_url FROM commerce_owned_stripe_status t JOIN commerce_owned_stripe_dispatches d ON d.claim_id=t.claim_id WHERE d.attempt_command_id=a.command_id ORDER BY d.expected_version DESC LIMIT 1) AS hostedUrl,
 (SELECT f.id FROM commerce_payment_capture_facts f WHERE f.attempt_command_id=a.command_id AND f.account_ref=b.actual_account_id LIMIT 1) AS factId,
 (SELECT d.claim_id FROM commerce_owned_stripe_dispatches d WHERE d.attempt_command_id=a.command_id AND d.kind='create') AS dispatchId
 FROM commerce_checkout_order_origins x JOIN commerce_orders o ON o.id=x.order_id
 JOIN commerce_payment_scope s ON s.id=1 AND s.mode=x.mode AND s.instance_id=x.instance_id AND s.stripe_account_ref='fixture-stripe'
 LEFT JOIN commerce_payment_attempts a ON a.order_id=o.id AND a.mode=x.mode AND a.instance_id=x.instance_id AND a.owner_hash=x.owner_hash AND a.quote_id=x.promoted_quote_id AND a.rules_version='fictional-checkout-acceptance-v1' AND a.provider='stripe' AND a.account_ref=s.stripe_account_ref
 LEFT JOIN commerce_owned_stripe_associations b ON b.attempt_command_id=a.command_id
 LEFT JOIN commerce_payment_work w ON w.attempt_command_id=a.command_id LEFT JOIN commerce_payment_work_claims k ON k.claim_id=w.current_claim_id
 LEFT JOIN commerce_owned_stripe_sessions z ON z.attempt_command_id=a.command_id
 WHERE x.mode=? AND x.instance_id=? AND x.owner_hash=? AND x.order_id=? AND o.owner_hash=x.owner_hash AND o.quote_id=x.promoted_quote_id AND o.reserve_command_id=x.command_id`,
    )
    .bind(c.mode, c.instanceId, i.ownerHash, i.orderId)
    .first<Row>();
  if (
    r?.actualAccountId &&
    (r.actualAccountId !== c.expectedAccountId ||
      r.canonicalOrigin !== c.canonicalOrigin)
  )
    fail("conflict");
  return r;
}
function project(r: Row, now: number): OwnedStripePayment {
  if (
    r.factId &&
    r.state === "confirmed" &&
    r.paymentState === "succeeded" &&
    r.fulfillment === "ready_to_pack"
  )
    return { state: "paid", canStart: false, canQuery: false };
  if (
    r.state !== "pending_payment" ||
    !["not_started", "processing"].includes(r.paymentState) ||
    r.fulfillment !== "none"
  )
    return { state: "review_required", canStart: false, canQuery: false };
  if (!r.dispatchId)
    return {
      state: "not_started",
      canStart: now < r.reserveUntil,
      canQuery: false,
    };
  if (!r.sessionId)
    return { state: "review_required", canStart: false, canQuery: false };
  if (r.sessionStatus === "expired")
    return { state: "expired", canStart: false, canQuery: true };
  if (r.sessionStatus === "open")
    return {
      state: "open",
      hostedUrl: r.hostedUrl,
      canStart: false,
      canQuery: true,
    };
  return { state: "checking", canStart: false, canQuery: true };
}
export async function readOwnedStripePayment(
  db: D1Database,
  rawConfig: StripeSandboxConfig,
  ownerHash: string,
  orderId: string,
): Promise<OwnedStripePayment | null> {
  const c = config(rawConfig),
    i = identity({ ownerHash, orderId });
  return safe(async () => {
    const r = await load(db, c, i);
    return r ? project(r, Date.now()) : null;
  });
}
function association(r: Row): StripeSandboxAssociation {
  if (
    !r.attemptId ||
    !r.createOperationKey ||
    !r.amountCents ||
    !r.sessionExpiresAt
  )
    fail("conflict");
  return {
    orderId: r.orderId,
    attemptId: r.requestId!,
    createOperationKey: r.createOperationKey,
    amountCents: r.amountCents,
    sessionExpiresAt: r.sessionExpiresAt,
  };
}
async function requireRow(
  db: D1Database,
  c: StripeSandboxConfig,
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
    "owned-stripe-dispatch-v1",
    r.attemptId,
    kind,
    claimId,
    workerId,
    r.workVersion,
  ]);
  const now = time(clock);
  const written = await db
    .prepare(
      `INSERT INTO commerce_owned_stripe_dispatches(claim_id,attempt_command_id,worker_id,request_hash,expected_version,kind,claimed_at) VALUES(?,?,?,?,?,?,?)`,
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
  const confirmed = await db
    .prepare(
      `SELECT d.claim_id AS claimId
   FROM commerce_owned_stripe_dispatches d
   JOIN commerce_payment_work_claims c ON c.claim_id=d.claim_id
   JOIN commerce_payment_work w ON w.attempt_command_id=d.attempt_command_id
   JOIN commerce_payment_attempts a ON a.command_id=d.attempt_command_id
   WHERE d.claim_id=? AND d.attempt_command_id=? AND d.worker_id=? AND d.request_hash=?
   AND d.expected_version=? AND d.kind=? AND d.claimed_at=?
   AND c.attempt_command_id=d.attempt_command_id AND c.worker_id=d.worker_id
   AND c.request_hash=d.request_hash AND c.expected_version=d.expected_version
   AND c.kind=d.kind AND c.claimed_at=d.claimed_at AND c.lease_until=d.claimed_at+30000
   AND c.mode=a.mode AND c.instance_id=a.instance_id AND c.provider=a.provider AND c.account_ref=a.account_ref
   AND w.current_claim_id=d.claim_id AND w.version=d.expected_version+1 AND w.next_operation='query'`,
    )
    .bind(claimId, r.attemptId, workerId, requestHash, r.workVersion, kind, now)
    .first<{ claimId: string }>();
  if (confirmed?.claimId !== claimId) fail("unavailable");
  return { claimId, workerId, now };
}
async function saveSession(
  db: D1Database,
  r: Row,
  s: StripeSandboxSession,
  claimId: string | null,
  now: number,
) {
  const existing = await db
    .prepare(
      "SELECT session_id AS id FROM commerce_owned_stripe_sessions WHERE attempt_command_id=?",
    )
    .bind(r.attemptId)
    .first<{ id: string }>();
  if (existing && existing.id !== s.sessionId) fail("conflict");
  const writes: D1PreparedStatement[] = [];
  if (!existing)
    writes.push(
      db
        .prepare(
          "INSERT INTO commerce_owned_stripe_sessions(attempt_command_id,session_id,recorded_at) VALUES(?,?,?)",
        )
        .bind(r.attemptId, s.sessionId, now),
    );
  if (claimId)
    writes.push(
      db
        .prepare(
          "INSERT INTO commerce_owned_stripe_status(claim_id,session_id,status,payment_status,hosted_url,recorded_at) VALUES(?,?,?,?,?,?)",
        )
        .bind(
          claimId,
          s.sessionId,
          s.status,
          s.paymentStatus,
          s.status === "open" ? s.hostedUrl : null,
          now,
        ),
    );
  if (writes.length) await db.batch(writes);
}
// Hook errors (e.g. expired/revoked browser session) intentionally preserve their
// typed caller contract. Storage/provider errors never contain secrets or SQL.
async function reauthorize(hook?: () => Promise<void>) {
  if (hook) await hook();
}
export async function startOwnedStripePayment(
  db: D1Database,
  rawConfig: StripeSandboxConfig,
  rawInput: { ownerHash: string; orderId: string },
  fetcher: StripeSandboxFetch,
  clock: () => number = Date.now,
  beforeDispatch?: () => Promise<void>,
): Promise<OwnedStripePayment> {
  const c = config(rawConfig),
    i = identity(rawInput);
  if (typeof fetcher !== "function") fail("invalid_request");
  let r = await safe(() => requireRow(db, c, i));
  if (r.dispatchId || r.factId) return project(r, time(clock));
  if (!r.attemptId) fail("conflict");
  await reauthorize(beforeDispatch);
  if (!r.actualAccountId) {
    const now = time(clock);
    try {
      await db
        .prepare(
          "INSERT INTO commerce_owned_stripe_associations(attempt_command_id,actual_account_id,canonical_origin,session_expires_at,created_at) VALUES(?,?,?,?,?)",
        )
        .bind(
          r.attemptId,
          c.expectedAccountId,
          c.canonicalOrigin,
          Math.floor(now / 1000) + 3600,
          now,
        )
        .run();
    } catch {
      /* A concurrent same-attempt winner may have committed. */
    }
    r = await safe(() => requireRow(db, c, i));
    if (!r.actualAccountId) fail("unavailable");
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
  let session: StripeSandboxSession;
  try {
    session = await createStripeSandboxSession(
      c,
      association(r),
      fetcher,
      clock,
    );
  } catch {
    return { state: "review_required", canStart: false, canQuery: false };
  }
  await reauthorize(beforeDispatch);
  return safe(async () => {
    try {
      await saveSession(db, r, session, claim.claimId, time(clock));
    } catch {
      const recovered = await requireRow(db, c, i);
      if (recovered.sessionId !== session.sessionId) fail("unavailable");
    }
    return project(await requireRow(db, c, i), time(clock));
  });
}
export async function reconcileOwnedStripePayment(
  db: D1Database,
  rawConfig: StripeSandboxConfig,
  rawInput: { ownerHash: string; orderId: string },
  fetcher: StripeSandboxFetch,
  clock: () => number = Date.now,
  beforeDispatch?: () => Promise<void>,
): Promise<OwnedStripePayment> {
  const c = config(rawConfig),
    i = identity(rawInput);
  if (typeof fetcher !== "function") fail("invalid_request");
  const r = await safe(() => requireRow(db, c, i));
  if (r.factId || !r.sessionId) return project(r, time(clock));
  await reauthorize(beforeDispatch);
  let claim: Awaited<ReturnType<typeof dispatch>>;
  try {
    claim = await dispatch(db, r, "query", clock);
  } catch {
    return safe(async () => project(await requireRow(db, c, i), time(clock)));
  }
  const a = { ...association(r), sessionId: r.sessionId };
  let session: StripeSandboxSession;
  try {
    session = await retrieveStripeSandboxSession(c, a, fetcher);
  } catch {
    return { state: "review_required", canStart: false, canQuery: true };
  }
  await reauthorize(beforeDispatch);
  try {
    await saveSession(db, r, session, claim.claimId, time(clock));
  } catch {
    fail("unavailable");
  }
  if (session.status !== "complete" || session.paymentStatus !== "paid")
    return safe(async () => project(await requireRow(db, c, i), time(clock)));
  let capture: Awaited<ReturnType<typeof retrieveStripeSandboxCapture>>;
  try {
    capture = await retrieveStripeSandboxCapture(c, a, fetcher);
  } catch {
    return { state: "review_required", canStart: false, canQuery: true };
  }
  await reauthorize(beforeDispatch);
  return safe(async () => {
    const payloadHash = await hash([
      "owned-stripe-capture-v1",
      c.instanceId,
      c.expectedAccountId,
      a,
      capture,
    ]);
    const factId = await hash([
      "owned-stripe-transaction-v1",
      c.instanceId,
      c.expectedAccountId,
      capture.chargeId,
    ]);
    try {
      await db
        .prepare(
          `INSERT INTO commerce_payment_capture_facts(id,attempt_command_id,source_claim_id,source_worker_id,mode,instance_id,provider,account_ref,provider_object_ref,transaction_ref,actual_amount_cents,actual_currency,expected_amount_cents,expected_currency,amount_match,payload_hash,recorded_at,payment_intent_ref) VALUES(?,?,?,?,'local-test',?,'stripe',?,?,?,?,'CAD',?,'CAD','match',?,?,?)`,
        )
        .bind(
          factId,
          r.attemptId,
          claim.claimId,
          claim.workerId,
          c.instanceId,
          c.expectedAccountId,
          r.sessionId,
          capture.chargeId,
          capture.amountCents,
          r.amountCents,
          payloadHash,
          time(clock),
          capture.paymentIntentId,
        )
        .run();
    } catch {
      const after = await requireRow(db, c, i);
      if (!after.factId)
        return { state: "review_required", canStart: false, canQuery: true };
    }
    return project(await requireRow(db, c, i), time(clock));
  });
}
/** Caller supplies ONLY the output of verifyStripeSandboxWebhook. A signed event
 * is a wakeup and Session candidate, never payment truth. Replays may requery.
 */
export async function recordOwnedStripeEvent(
  db: D1Database,
  rawConfig: StripeSandboxConfig,
  event: VerifiedStripeSandboxEvent,
  fetcher: StripeSandboxFetch,
  clock: () => number = Date.now,
): Promise<void> {
  const c = config(rawConfig);
  if (typeof fetcher !== "function") fail("invalid_request");
  const e = fields(
    event,
    ["testOnly", "eventId", "eventType", "apiVersion", "createdAt", "session"],
    "invalid_request",
  );
  if (
    e.testOnly !== true ||
    e.apiVersion !== STRIPE_SANDBOX_API_VERSION ||
    ![
      "checkout.session.completed",
      "checkout.session.expired",
      "checkout.session.async_payment_succeeded",
      "checkout.session.async_payment_failed",
    ].includes(e.eventType as string)
  )
    fail("invalid_request");
  const eventId = text(e.eventId, /^evt_[A-Za-z0-9]{8,240}$/);
  const v = fields(
    e.session,
    [
      "testOnly",
      "sessionId",
      "status",
      "paymentStatus",
      "paymentIntentId",
      "hostedUrl",
      "amountCents",
      "currency",
      "orderId",
      "attemptId",
      "createOperationKey",
      "sessionExpiresAt",
    ],
    "invalid_request",
  );
  const sessionId = text(v.sessionId, /^cs_test_[A-Za-z0-9]{8,240}$/),
    requestId = text(v.attemptId, uuid),
    attemptId = `payment-start-${requestId}`,
    orderId = text(v.orderId, /^order-[a-f0-9-]{36}$/);
  // Copy all scalar association values before the first await; no event contact data.
  const candidate = {
    orderId,
    attemptId: requestId,
    createOperationKey: text(v.createOperationKey, uuid),
    amountCents: v.amountCents,
    sessionExpiresAt: v.sessionExpiresAt,
  };
  if (
    !Number.isSafeInteger(v.amountCents) ||
    (v.amountCents as number) <= 0 ||
    !Number.isSafeInteger(v.sessionExpiresAt) ||
    (v.sessionExpiresAt as number) <= 0 ||
    !Number.isSafeInteger(e.createdAt) ||
    (e.createdAt as number) < 0
  )
    fail("invalid_request");
  const digest = await hash([
    eventId,
    e.eventType,
    e.createdAt,
    sessionId,
    candidate,
  ]);
  await safe(async () => {
    const owner = await db
      .prepare(
        `SELECT a.owner_hash AS ownerHash FROM commerce_payment_attempts a JOIN commerce_owned_stripe_associations b ON b.attempt_command_id=a.command_id WHERE a.command_id=? AND a.order_id=? AND a.mode='local-test' AND a.instance_id=? AND b.actual_account_id=? AND b.canonical_origin=?`,
      )
      .bind(
        attemptId,
        orderId,
        c.instanceId,
        c.expectedAccountId,
        c.canonicalOrigin,
      )
      .first<{ ownerHash: string }>();
    if (!owner) return;
    const i = identity({ ownerHash: owner.ownerHash, orderId }),
      r = await requireRow(db, c, i);
    if (
      !r.dispatchId ||
      JSON.stringify(association(r)) !== JSON.stringify(candidate) ||
      (r.sessionId && r.sessionId !== sessionId)
    )
      return;
    const original = await db
      .prepare(
        "SELECT payload_hash AS hash FROM commerce_owned_stripe_events WHERE event_id=? AND attempt_command_id=?",
      )
      .bind(eventId, attemptId)
      .first<{ hash: string }>();
    if (original && original.hash !== digest) fail("conflict");
    if (!original) {
      try {
        await db
          .prepare(
            "INSERT INTO commerce_owned_stripe_events(event_id,attempt_command_id,session_id,payload_hash,recorded_at) VALUES(?,?,?,?,?)",
          )
          .bind(eventId, attemptId, sessionId, digest, time(clock))
          .run();
      } catch {
        const saved = await db
          .prepare(
            "SELECT payload_hash AS hash FROM commerce_owned_stripe_events WHERE event_id=? AND attempt_command_id=?",
          )
          .bind(eventId, attemptId)
          .first<{ hash: string }>();
        if (saved?.hash !== digest) fail("unavailable");
      }
    }
    if (!r.sessionId) {
      // Recover a lost CREATE ID using a fresh canonical read, not event fields.
      let s: StripeSandboxSession;
      try {
        s = await retrieveStripeSandboxSession(
          c,
          { ...association(r), sessionId },
          fetcher,
        );
      } catch {
        fail("unavailable");
      }
      try {
        await saveSession(db, r, s, null, time(clock));
      } catch {
        const saved = await requireRow(db, c, i);
        if (saved.sessionId !== sessionId) fail("unavailable");
      }
    }
    const result = await reconcileOwnedStripePayment(db, c, i, fetcher, clock);
    if (!["paid", "expired"].includes(result.state)) fail("unavailable");
  });
}
