import type { AdminPrincipal } from "../auth/admin-access.server";
import { commandHash } from "./inventory.server";
import type {
  OwnerRefundScope,
  OwnerRefundInput,
  OwnerRefundDetail,
  OwnerRefundReceipt,
  OwnerRefundState,
} from "./owner-refund";
import type {
  StripeSandboxConfig,
  StripeSandboxFetch,
} from "./stripe-sandbox.server";
import {
  createStripeSandboxRefund,
  retrieveStripeSandboxRefund,
  type StripeSandboxRefundAssociation,
  type StripeSandboxRefund,
} from "./stripe-refund-sandbox.server";
import type {
  PayPalSandboxConfig,
  PayPalSandboxFetch,
} from "./paypal-sandbox.server";
import {
  createPayPalSandboxRefund,
  retrievePayPalSandboxRefund,
} from "./paypal-refund-sandbox.server";
export class OwnerRefundError extends Error {
  constructor(
    public readonly code:
      "invalid_request" | "not_found" | "conflict" | "unavailable",
  ) {
    super("The local test refund could not be confirmed");
    this.name = "OwnerRefundError";
  }
}
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const orderIdPattern = new RegExp(`^order-${uuid.source.slice(1, -1)}$`);
function fail(code: OwnerRefundError["code"]): never {
  throw new OwnerRefundError(code);
}
function fields(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail("invalid_request");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).length !== keys.length ||
    Reflect.ownKeys(descriptors).some(
      (k) => typeof k !== "string" || !keys.includes(k),
    )
  )
    fail("invalid_request");
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    const d = descriptors[key];
    if (!d || !("value" in d)) fail("invalid_request");
    copy[key] = d.value;
  }
  return copy;
}
function text(v: unknown, p: RegExp): string {
  if (typeof v !== "string" || !p.test(v)) fail("invalid_request");
  return v;
}
function integer(v: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max)
    fail("invalid_request");
  return v as number;
}
function scope(raw: unknown): OwnerRefundScope {
  const s = fields(raw, ["mode", "instanceId"]);
  if (s.mode !== "local-test") fail("invalid_request");
  return { mode: "local-test", instanceId: text(s.instanceId, uuid) };
}
function principal(raw: unknown): AdminPrincipal {
  const a = fields(raw, ["email", "sub"]);
  const email = text(a.email, /^[^\s\u0000-\u001f]{1,320}$/),
    sub = text(a.sub, /^[^\s\u0000-\u001f]{1,400}$/);
  return { email: email.toLowerCase(), sub };
}
function input(raw: unknown): OwnerRefundInput {
  const i = fields(raw, [
    "requestId",
    "orderId",
    "expectedVersion",
    "acknowledge",
  ]);
  if (i.acknowledge !== true) fail("invalid_request");
  return {
    requestId: text(i.requestId, uuid),
    orderId: text(i.orderId, orderIdPattern),
    expectedVersion: integer(i.expectedVersion, 1, Number.MAX_SAFE_INTEGER - 1),
    acknowledge: true,
  };
}
async function safe<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof OwnerRefundError) throw error;
    fail("unavailable");
  }
}
async function checkedScope(db: D1Database, s: OwnerRefundScope) {
  if (
    !(await db
      .prepare(
        "SELECT 1 AS ok FROM commerce_payment_scope WHERE id=1 AND mode=? AND instance_id=?",
      )
      .bind(s.mode, s.instanceId)
      .first())
  )
    fail("conflict");
}

type Saved = {
  request_id: string;
  mode: string;
  instance_id: string;
  actor_hash: string;
  request_hash: string;
  order_id: string;
  capture_id: string;
  expected_version: number;
  operation_key: string;
  provider: "stripe" | "paypal";
  account_ref: string;
  canonical_origin: string;
  transaction_ref: string;
  payment_intent_ref: string | null;
  provider_object_ref: string;
  payment_request_id: string;
  create_operation_key: string;
  amount_cents: number;
  recorded_at: number;
  dispatch_id: string | null;
  dispatch_at: number | null;
  refund_id: string | null;
  status: string | null;
  refunded_cents: number | null;
  succeeded: number;
};
const savedQuery = `SELECT r.*,d.dispatch_id,d.recorded_at AS dispatch_at,
 (SELECT refund_id FROM commerce_owner_refund_observations v WHERE v.request_id=r.request_id ORDER BY rowid DESC LIMIT 1) AS refund_id,
 (SELECT status FROM commerce_owner_refund_observations v WHERE v.request_id=r.request_id ORDER BY rowid DESC LIMIT 1) AS status,
 (SELECT refunded_cents FROM commerce_owner_refund_observations v WHERE v.request_id=r.request_id ORDER BY rowid DESC LIMIT 1) AS refunded_cents,
 EXISTS(SELECT 1 FROM commerce_owner_refund_observations v WHERE v.request_id=r.request_id AND v.status='succeeded' AND v.refunded_cents=r.amount_cents) AS succeeded
 FROM commerce_owner_refund_intents r LEFT JOIN commerce_owner_refund_dispatches d ON d.request_id=r.request_id`;
function state(r: Saved): OwnerRefundState {
  return r.succeeded === 1
    ? "succeeded"
    : r.status === "pending"
      ? "pending"
      : !r.dispatch_id
        ? "prepared"
        : "review_required";
}
function receipt(r: Saved): OwnerRefundReceipt {
  return {
    testOnly: true,
    requestId: r.request_id,
    orderId: r.order_id,
    state: state(r),
    amountCents: r.amount_cents,
    refundedCents: r.succeeded === 1 ? r.amount_cents : (r.refunded_cents ?? 0),
  };
}
async function detail(
  db: D1Database,
  s: OwnerRefundScope,
  orderId: string,
): Promise<OwnerRefundDetail | null> {
  const o = await db
    .prepare(
      `SELECT o.version,json_extract(o.snapshot,'$.totalCents') AS amount,
 (SELECT a.provider FROM commerce_payment_attempts a WHERE a.order_id=o.id AND a.mode=x.mode AND a.instance_id=x.instance_id AND a.owner_hash=x.owner_hash AND a.quote_id=x.promoted_quote_id AND a.rules_version='fictional-checkout-acceptance-v1' LIMIT 1) AS provider,
 EXISTS(SELECT 1 FROM commerce_owner_refund_sources c WHERE c.order_id=o.id AND c.mode=x.mode AND c.instance_id=x.instance_id) AS eligible
 FROM commerce_checkout_order_origins x JOIN commerce_orders o ON o.id=x.order_id
 WHERE x.order_id=? AND x.mode=? AND x.instance_id=? AND o.owner_hash=x.owner_hash AND o.quote_id=x.promoted_quote_id AND o.reserve_command_id=x.command_id AND o.created_at=x.created_at AND o.reserve_until=x.reserve_until`,
    )
    .bind(orderId, s.mode, s.instanceId)
    .first<{
      version: number;
      amount: number;
      provider: "stripe" | "paypal" | null;
      eligible: number;
    }>();
  if (!o) return null;
  const r = await db
    .prepare(
      savedQuery + " WHERE r.order_id=? AND r.mode=? AND r.instance_id=?",
    )
    .bind(orderId, s.mode, s.instanceId)
    .first<Saved>();
  return {
    orderId,
    orderVersion: o.version,
    amountCents: o.amount,
    provider: o.provider,
    requestId: r?.request_id ?? null,
    requestVersion: r?.expected_version ?? null,
    state: r ? state(r) : "not_started",
    refundedCents: r ? receipt(r).refundedCents : 0,
    canStart: !r && o.eligible === 1,
    canQuery: !!r?.dispatch_id && r.succeeded !== 1,
  };
}
export async function readOwnerRefund(
  db: D1Database,
  rawScope: OwnerRefundScope,
  rawOrderId: string,
): Promise<OwnerRefundDetail | null> {
  const s = scope(rawScope),
    orderId = text(rawOrderId, orderIdPattern);
  return safe(async () => {
    await checkedScope(db, s);
    return detail(db, s, orderId);
  });
}
type Identity = {
  s: OwnerRefundScope;
  i: OwnerRefundInput;
  actorHash: string;
  requestHash: string;
};
async function identity(
  s: OwnerRefundScope,
  a: AdminPrincipal,
  i: OwnerRefundInput,
): Promise<Identity> {
  const actorHash = await commandHash([
    "owner-refund-actor-v1",
    a.email,
    a.sub,
  ]);
  return {
    s,
    i,
    actorHash,
    requestHash: await commandHash(["owner-refund-v1", s, actorHash, i]),
  };
}
async function find(db: D1Database, id: Identity): Promise<Saved | null> {
  const r = await db
    .prepare(savedQuery + " WHERE r.request_id=?")
    .bind(id.i.requestId)
    .first<Saved>();
  if (!r) return null;
  if (
    r.mode !== id.s.mode ||
    r.instance_id !== id.s.instanceId ||
    r.actor_hash !== id.actorHash ||
    r.request_hash !== id.requestHash
  )
    fail("conflict");
  if (
    r.order_id !== id.i.orderId ||
    r.expected_version !== id.i.expectedVersion ||
    r.operation_key !== r.request_id
  )
    fail("unavailable");
  return r;
}
export async function lookupOwnerRefundCommand(
  db: D1Database,
  rawScope: OwnerRefundScope,
  rawActor: AdminPrincipal,
  rawInput: OwnerRefundInput,
): Promise<
  { state: "recorded"; receipt: OwnerRefundReceipt } | { state: "not_recorded" }
> {
  const s = scope(rawScope),
    a = principal(rawActor),
    i = input(rawInput);
  return safe(async () => {
    await checkedScope(db, s);
    const r = await find(db, await identity(s, a, i));
    return r
      ? { state: "recorded", receipt: receipt(r) }
      : { state: "not_recorded" };
  });
}
function time(clock: () => number) {
  try {
    return integer(clock(), 0, 8640000000000000);
  } catch {
    fail("invalid_request");
  }
}
function configuration(
  raw: StripeSandboxConfig,
  s: OwnerRefundScope,
): StripeSandboxConfig {
  const c = fields(raw, [
    "enabled",
    "mode",
    "instanceId",
    "expectedAccountId",
    "testSecretKey",
    "canonicalOrigin",
  ]);
  if (c.enabled !== true || c.mode !== s.mode || c.instanceId !== s.instanceId)
    fail("invalid_request");
  const origin = text(
    c.canonicalOrigin,
    /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/,
  );
  try {
    if (new URL(origin).origin !== origin) fail("invalid_request");
  } catch {
    fail("invalid_request");
  }
  return {
    enabled: true,
    ...s,
    expectedAccountId: text(c.expectedAccountId, /^acct_[A-Za-z0-9]{8,100}$/),
    testSecretKey: text(c.testSecretKey, /^sk_test_[A-Za-z0-9]{16,240}$/),
    canonicalOrigin: origin,
  };
}
function transport(
  fetcher: StripeSandboxFetch,
  clock: () => number,
  hook?: () => Promise<void>,
) {
  if (
    typeof fetcher !== "function" ||
    typeof clock !== "function" ||
    (hook !== undefined && typeof hook !== "function")
  )
    fail("invalid_request");
}
function association(r: Saved): StripeSandboxRefundAssociation {
  return {
    orderId: r.order_id,
    paymentRequestId: r.payment_request_id,
    createOperationKey: r.create_operation_key,
    requestId: r.request_id,
    operationKey: r.operation_key,
    captureId: r.capture_id,
    chargeId: r.transaction_ref,
    paymentIntentId: r.payment_intent_ref!,
    amountCents: r.amount_cents,
  };
}
type RefundAdapter = {
  provider: "stripe" | "paypal";
  accountRef: string;
  canonicalOrigin: string;
  create: (r: Saved, guard: () => Promise<void>) => Promise<string>;
  retrieve: (
    r: Saved,
    knownId: string | null,
  ) => Promise<StripeSandboxRefund | null>;
};
function configured(r: Saved, c: RefundAdapter) {
  if (
    r.provider !== c.provider ||
    r.account_ref !== c.accountRef ||
    r.canonical_origin !== c.canonicalOrigin
  )
    fail("conflict");
}
function stripeAdapter(
  c: StripeSandboxConfig,
  fetcher: StripeSandboxFetch,
): RefundAdapter {
  return {
    provider: "stripe",
    accountRef: c.expectedAccountId,
    canonicalOrigin: c.canonicalOrigin,
    create: (r, guard) =>
      createStripeSandboxRefund(c, association(r), fetcher, guard),
    retrieve: (r, known) =>
      retrieveStripeSandboxRefund(c, association(r), fetcher, known),
  };
}
function paypalConfiguration(
  raw: PayPalSandboxConfig,
  s: OwnerRefundScope,
): PayPalSandboxConfig {
  const c = fields(raw, [
    "enabled",
    "mode",
    "instanceId",
    "expectedMerchantId",
    "clientId",
    "clientSecret",
    "canonicalOrigin",
  ]);
  if (c.enabled !== true || c.mode !== s.mode || c.instanceId !== s.instanceId)
    fail("invalid_request");
  const canonicalOrigin = text(
    c.canonicalOrigin,
    /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/,
  );
  try {
    if (new URL(canonicalOrigin).origin !== canonicalOrigin)
      fail("invalid_request");
  } catch {
    fail("invalid_request");
  }
  return {
    enabled: true,
    ...s,
    canonicalOrigin,
    expectedMerchantId: text(c.expectedMerchantId, /^[2-9A-HJ-NP-Z]{13}$/),
    clientId: text(c.clientId, /^[\x21-\x39\x3B-\x7E]{16,512}$/),
    clientSecret: text(c.clientSecret, /^[\x21-\x7E]{16,512}$/),
  };
}
function paypalAdapter(
  c: PayPalSandboxConfig,
  fetcher: PayPalSandboxFetch,
): RefundAdapter {
  const original = (r: Saved) => ({
    orderId: r.order_id,
    attemptId: r.payment_request_id,
    createOperationKey: r.create_operation_key,
    providerOrderId: r.provider_object_ref,
    captureId: r.transaction_ref,
    amountCents: r.amount_cents,
    refundOperationKey: r.operation_key,
  });
  return {
    provider: "paypal",
    accountRef: c.expectedMerchantId,
    canonicalOrigin: c.canonicalOrigin,
    create: async (r, guard) =>
      (await createPayPalSandboxRefund(c, original(r), fetcher, guard))
        .refundId,
    retrieve: (r, known) =>
      retrievePayPalSandboxRefund(c, original(r), fetcher, known),
  };
}
async function persistObservation(
  db: D1Database,
  id: Identity,
  value: StripeSandboxRefund,
  clock: () => number,
) {
  const observationId = crypto.randomUUID(),
    now = time(clock);
  try {
    await db
      .prepare(
        "INSERT INTO commerce_owner_refund_observations(observation_id,request_id,refund_id,status,amount_cents,refunded_cents,recorded_at) VALUES(?,?,?,?,?,?,?)",
      )
      .bind(
        observationId,
        id.i.requestId,
        value.refundId,
        value.status,
        value.amountCents,
        value.refundedCents,
        now,
      )
      .run();
  } catch {
    /* Exact readback below handles a lost acknowledgment. */
  }
  const saved = await db
    .prepare(
      "SELECT 1 AS ok FROM commerce_owner_refund_observations WHERE observation_id=? AND request_id=? AND refund_id=? AND status=? AND amount_cents=? AND refunded_cents=? AND recorded_at=?",
    )
    .bind(
      observationId,
      id.i.requestId,
      value.refundId,
      value.status,
      value.amountCents,
      value.refundedCents,
      now,
    )
    .first();
  if (!saved) fail("unavailable");
  const r = await find(db, id);
  if (!r) fail("unavailable");
  return receipt(r);
}
async function query(
  db: D1Database,
  id: Identity,
  r: Saved,
  c: RefundAdapter,
  clock: () => number,
  hook?: () => Promise<void>,
  knownId: string | null = null,
) {
  if (hook) await hook();
  let result: StripeSandboxRefund | null;
  try {
    result = await c.retrieve(r, knownId ?? r.refund_id);
  } catch {
    return { ...receipt(r), state: "review_required" as const };
  }
  if (hook) await hook();
  if (!result) return { ...receipt(r), state: "review_required" as const };
  return safe(() => persistObservation(db, id, result, clock));
}
async function startRefund(
  db: D1Database,
  rawScope: OwnerRefundScope,
  rawActor: AdminPrincipal,
  rawInput: OwnerRefundInput,
  c: RefundAdapter,
  clock: () => number = Date.now,
  beforeMutation?: () => Promise<void>,
): Promise<OwnerRefundReceipt> {
  const s = scope(rawScope),
    a = principal(rawActor),
    i = input(rawInput);
  const id = await safe(() => identity(s, a, i));
  const replay = await safe(async () => {
    await checkedScope(db, s);
    return find(db, id);
  });
  // Existing intent NEVER authorizes another POST, even if no dispatch exists.
  if (replay) {
    configured(replay, c);
    return receipt(replay);
  }
  if (beforeMutation) await beforeMutation();
  const now = time(clock);
  let intentAcknowledged = false;
  await safe(async () => {
    const source = await db
      .prepare(
        "SELECT * FROM commerce_owner_refund_sources WHERE order_id=? AND mode=? AND instance_id=?",
      )
      .bind(i.orderId, s.mode, s.instanceId)
      .first<{
        capture_id: string;
        provider: "stripe" | "paypal";
        version: number;
        account_ref: string;
        canonical_origin: string;
        transaction_ref: string;
        payment_intent_ref: string | null;
        provider_object_ref: string;
        payment_request_id: string;
        create_operation_key: string;
        amount_cents: number;
      }>();
    if (!source) {
      if (!(await detail(db, s, i.orderId))) fail("not_found");
      fail("conflict");
    }
    if (
      source.version !== i.expectedVersion ||
      source.provider !== c.provider ||
      source.account_ref !== c.accountRef ||
      source.canonical_origin !== c.canonicalOrigin
    )
      fail("conflict");
    try {
      const written = await db
        .prepare(
          `INSERT INTO commerce_owner_refund_intents(request_id,mode,instance_id,actor_hash,request_hash,order_id,capture_id,expected_version,operation_key,provider,account_ref,canonical_origin,transaction_ref,payment_intent_ref,provider_object_ref,payment_request_id,create_operation_key,amount_cents,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          i.requestId,
          s.mode,
          s.instanceId,
          id.actorHash,
          id.requestHash,
          i.orderId,
          source.capture_id,
          i.expectedVersion,
          i.requestId,
          source.provider,
          source.account_ref,
          source.canonical_origin,
          source.transaction_ref,
          source.payment_intent_ref,
          source.provider_object_ref,
          source.payment_request_id,
          source.create_operation_key,
          source.amount_cents,
          now,
        )
        .run();
      intentAcknowledged =
        written.success === true && written.meta?.changes === 1;
    } catch {
      if (await find(db, id)) return;
      const current = await detail(db, s, i.orderId);
      if (current?.requestId || current?.orderVersion !== i.expectedVersion)
        fail("conflict");
      fail("unavailable");
    }
  });
  let r = await safe(() => find(db, id));
  if (!r) fail("unavailable");
  configured(r, c);
  if (r.dispatch_id || !intentAcknowledged) return receipt(r);
  if (beforeMutation) await beforeMutation();
  const dispatchId = crypto.randomUUID(),
    dispatchedAt = time(clock);
  const readDispatch = () =>
    db
      .prepare(
        `SELECT 1 AS ok FROM commerce_owner_refund_dispatches d JOIN commerce_owner_refund_intents r ON r.request_id=d.request_id JOIN commerce_owner_refund_sources s ON s.capture_id=r.capture_id
 WHERE d.request_id=? AND d.dispatch_id=? AND d.recorded_at=? AND r.request_hash=? AND r.actor_hash=? AND r.mode=? AND r.instance_id=? AND r.order_id=? AND r.expected_version=? AND r.operation_key=? AND r.provider=? AND r.account_ref=? AND r.canonical_origin=? AND r.transaction_ref=? AND r.payment_intent_ref IS ? AND r.provider_object_ref=? AND r.payment_request_id=? AND r.create_operation_key=? AND r.amount_cents=? AND r.capture_id=? AND r.recorded_at=? AND s.provider=r.provider AND s.version=r.expected_version AND s.order_id=r.order_id AND s.mode=r.mode AND s.instance_id=r.instance_id AND s.account_ref=r.account_ref AND s.canonical_origin=r.canonical_origin AND s.transaction_ref=r.transaction_ref AND s.payment_intent_ref IS r.payment_intent_ref AND s.provider_object_ref=r.provider_object_ref AND s.payment_request_id=r.payment_request_id AND s.create_operation_key=r.create_operation_key AND s.amount_cents=r.amount_cents`,
      )
      .bind(
        i.requestId,
        dispatchId,
        dispatchedAt,
        id.requestHash,
        id.actorHash,
        s.mode,
        s.instanceId,
        i.orderId,
        i.expectedVersion,
        r!.operation_key,
        r!.provider,
        r!.account_ref,
        r!.canonical_origin,
        r!.transaction_ref,
        r!.payment_intent_ref,
        r!.provider_object_ref,
        r!.payment_request_id,
        r!.create_operation_key,
        r!.amount_cents,
        r!.capture_id,
        r!.recorded_at,
      )
      .first();
  let acknowledged = false;
  try {
    const written = await db
      .prepare(
        "INSERT INTO commerce_owner_refund_dispatches(request_id,dispatch_id,recorded_at) VALUES(?,?,?)",
      )
      .bind(i.requestId, dispatchId, dispatchedAt)
      .run();
    acknowledged = written.success === true && written.meta?.changes === 1;
    if (acknowledged) acknowledged = !!(await readDispatch());
  } catch {
    acknowledged = false;
    /* Lost acknowledgment permanently consumes dispatch permission. */
  }
  r = await safe(() => find(db, id));
  if (!r) fail("unavailable");
  if (!acknowledged) return receipt(r);
  let guardError: unknown,
    guardFailed = false;
  const guard = async () => {
    try {
      if (beforeMutation) await beforeMutation();
      if (!(await safe(readDispatch))) fail("unavailable");
      const t = time(clock);
      if (t < dispatchedAt || t > dispatchedAt + 30000) fail("unavailable");
    } catch (error) {
      guardFailed = true;
      guardError = error;
      throw error;
    }
  };
  let refundId: string;
  try {
    refundId = await c.create(r, guard);
  } catch {
    if (guardFailed) throw guardError;
    return { ...receipt(r), state: "review_required" };
  }
  return query(db, id, r, c, clock, beforeMutation, refundId);
}
async function reconcileRefund(
  db: D1Database,
  rawScope: OwnerRefundScope,
  rawActor: AdminPrincipal,
  rawInput: OwnerRefundInput,
  c: RefundAdapter,
  clock: () => number = Date.now,
  beforeQuery?: () => Promise<void>,
): Promise<OwnerRefundReceipt> {
  const s = scope(rawScope),
    a = principal(rawActor),
    i = input(rawInput);
  const id = await safe(() => identity(s, a, i));
  const r = await safe(async () => {
    await checkedScope(db, s);
    return find(db, id);
  });
  if (!r) fail("not_found");
  configured(r, c);
  if (r.succeeded === 1 || !r.dispatch_id) return receipt(r);
  return query(db, id, r, c, clock, beforeQuery);
}

export async function startOwnerStripeRefund(
  db: D1Database,
  rawScope: OwnerRefundScope,
  actor: AdminPrincipal,
  input: OwnerRefundInput,
  config: StripeSandboxConfig,
  fetcher: StripeSandboxFetch,
  clock: () => number = Date.now,
  hook?: () => Promise<void>,
): Promise<OwnerRefundReceipt> {
  const scoped = scope(rawScope);
  transport(fetcher, clock, hook);
  return startRefund(
    db,
    scoped,
    actor,
    input,
    stripeAdapter(configuration(config, scoped), fetcher),
    clock,
    hook,
  );
}

export async function reconcileOwnerStripeRefund(
  db: D1Database,
  rawScope: OwnerRefundScope,
  actor: AdminPrincipal,
  input: OwnerRefundInput,
  config: StripeSandboxConfig,
  fetcher: StripeSandboxFetch,
  clock: () => number = Date.now,
  hook?: () => Promise<void>,
): Promise<OwnerRefundReceipt> {
  const scoped = scope(rawScope);
  transport(fetcher, clock, hook);
  return reconcileRefund(
    db,
    scoped,
    actor,
    input,
    stripeAdapter(configuration(config, scoped), fetcher),
    clock,
    hook,
  );
}

export async function startOwnerPayPalRefund(
  db: D1Database,
  rawScope: OwnerRefundScope,
  actor: AdminPrincipal,
  input: OwnerRefundInput,
  config: PayPalSandboxConfig,
  fetcher: PayPalSandboxFetch,
  clock: () => number = Date.now,
  hook?: () => Promise<void>,
): Promise<OwnerRefundReceipt> {
  const scoped = scope(rawScope);
  transport(fetcher, clock, hook);
  return startRefund(
    db,
    scoped,
    actor,
    input,
    paypalAdapter(paypalConfiguration(config, scoped), fetcher),
    clock,
    hook,
  );
}

export async function reconcileOwnerPayPalRefund(
  db: D1Database,
  rawScope: OwnerRefundScope,
  actor: AdminPrincipal,
  input: OwnerRefundInput,
  config: PayPalSandboxConfig,
  fetcher: PayPalSandboxFetch,
  clock: () => number = Date.now,
  hook?: () => Promise<void>,
): Promise<OwnerRefundReceipt> {
  const scoped = scope(rawScope);
  transport(fetcher, clock, hook);
  return reconcileRefund(
    db,
    scoped,
    actor,
    input,
    paypalAdapter(paypalConfiguration(config, scoped), fetcher),
    clock,
    hook,
  );
}
