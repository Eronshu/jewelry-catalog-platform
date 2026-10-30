import { testCheckoutRulesWitness } from "./checkout-acceptance.server";
import { legacyLabSource } from "./legacy-lab-source.server";
import { commandHash } from "./inventory.server";

export class PaymentStartError extends Error {
  constructor(
    public readonly code:
      "invalid_request" | "not_found" | "conflict" | "unavailable",
  ) {
    super("Local test payment intent could not be confirmed");
    this.name = "PaymentStartError";
  }
}
export type TrustedTestPaymentContext = {
  mode: "local-test";
  instanceId: string;
  provider: "stripe" | "paypal";
  accountRef: string;
  ownerHash: string;
};
export type TestPaymentStartInput = {
  requestId: string;
  reference: string;
  expectedVersion: number;
};
/** Evidence of a persisted local intent only, never dispatch or payment. */
export type TestPaymentStartReceipt = {
  testOnly: true;
  requestId: string;
  reference: string;
  provider: "stripe" | "paypal";
  amountCents: number;
  currency: "CAD";
  expectedVersion: number;
  resultingVersion: number;
  recordedAt: number;
  createOperationKey: string;
  replayed: boolean;
};
type Scope = {
  mode: string;
  instanceId: string;
  stripeAccountRef: string;
  paypalAccountRef: string;
};
type Saved = {
  requestHash: string;
  requestId: string | null;
  reference: string | null;
  ownerHash: string | null;
  mode: string | null;
  instanceId: string | null;
  provider: "stripe" | "paypal" | null;
  accountRef: string | null;
  amountCents: number | null;
  currency: "CAD" | null;
  expectedVersion: number | null;
  recordedAt: number | null;
  createOperationKey: string | null;
};
type Current = {
  quoteId: string;
  snapshot: string;
  quoteSnapshot: string;
  quoteOwner: string;
  quoteExpiresAt: number;
  quoteCreatedAt: number;
  createdAt: number;
  state: string;
  paymentState: string;
  fulfillment: string;
  reserveUntil: number;
  version: number;
};
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const reference =
  /^order-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const maxDate = 8_640_000_000_000_000;
function shape(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function safe(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}
function validate(
  trusted: TrustedTestPaymentContext,
  input: TestPaymentStartInput,
  now: number,
) {
  if (
    !shape(trusted, [
      "mode",
      "instanceId",
      "provider",
      "accountRef",
      "ownerHash",
    ]) ||
    trusted.mode !== "local-test" ||
    typeof trusted.instanceId !== "string" ||
    !uuid.test(trusted.instanceId) ||
    (trusted.provider !== "stripe" && trusted.provider !== "paypal") ||
    typeof trusted.accountRef !== "string" ||
    !/^fixture-[A-Za-z0-9_-]{1,92}$/.test(trusted.accountRef) ||
    typeof trusted.ownerHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(trusted.ownerHash) ||
    !shape(input, ["requestId", "reference", "expectedVersion"]) ||
    typeof input.requestId !== "string" ||
    !uuid.test(input.requestId) ||
    typeof input.reference !== "string" ||
    !reference.test(input.reference) ||
    !safe(input.expectedVersion, 1) ||
    input.expectedVersion >= Number.MAX_SAFE_INTEGER ||
    !safe(now) ||
    now > maxDate
  )
    throw new PaymentStartError("invalid_request");
}
async function assertScope(db: D1Database, trusted: TrustedTestPaymentContext) {
  const scope = await db
    .prepare(
      `SELECT mode, instance_id AS instanceId, stripe_account_ref AS stripeAccountRef,
       paypal_account_ref AS paypalAccountRef FROM commerce_payment_scope WHERE id = 1`,
    )
    .first<Scope>();
  if (
    !scope ||
    scope.mode !== trusted.mode ||
    scope.instanceId !== trusted.instanceId ||
    (trusted.provider === "stripe"
      ? scope.stripeAccountRef
      : scope.paypalAccountRef) !== trusted.accountRef
  )
    throw new PaymentStartError("unavailable");
}
function previous(db: D1Database, commandId: string) {
  return db
    .prepare(
      `SELECT c.request_hash AS requestHash, a.request_id AS requestId, a.order_id AS reference,
       a.owner_hash AS ownerHash, a.mode, a.instance_id AS instanceId, a.provider, a.account_ref AS accountRef,
       a.amount_cents AS amountCents, a.currency, a.expected_version AS expectedVersion,
       a.occurred_at AS recordedAt, a.create_operation_key AS createOperationKey
       FROM commerce_commands c LEFT JOIN commerce_payment_attempts a ON a.command_id = c.id WHERE c.id = ?`,
    )
    .bind(commandId)
    .first<Saved>();
}
function receipt(
  saved: Saved | null,
  hash: string,
  trusted: TrustedTestPaymentContext,
  input: TestPaymentStartInput,
  replayed: boolean,
): TestPaymentStartReceipt | null {
  if (!saved) return null;
  if (
    saved.requestHash !== hash ||
    saved.requestId !== input.requestId ||
    saved.reference !== input.reference ||
    saved.expectedVersion !== input.expectedVersion ||
    saved.ownerHash !== trusted.ownerHash ||
    saved.mode !== trusted.mode ||
    saved.instanceId !== trusted.instanceId ||
    saved.provider !== trusted.provider ||
    saved.accountRef !== trusted.accountRef ||
    !safe(saved.amountCents, 1) ||
    saved.currency !== "CAD" ||
    !safe(saved.recordedAt) ||
    typeof saved.createOperationKey !== "string" ||
    !uuid.test(saved.createOperationKey)
  )
    throw new PaymentStartError("conflict");
  return {
    testOnly: true,
    requestId: input.requestId,
    reference: input.reference,
    provider: trusted.provider,
    amountCents: saved.amountCents,
    currency: "CAD",
    expectedVersion: input.expectedVersion,
    resultingVersion: input.expectedVersion + 1,
    recordedAt: saved.recordedAt,
    createOperationKey: saved.createOperationKey,
    replayed,
  };
}
type PaymentSource =
  { kind: "legacy" } | { kind: "owned"; rulesJson: string; rulesHash: string };
const ownedRulesVersion = "fictional-checkout-acceptance-v1";
function current(
  db: D1Database,
  trusted: TrustedTestPaymentContext,
  id: string,
  source: PaymentSource,
) {
  const owned = source.kind === "owned";
  return db
    .prepare(
      `SELECT o.quote_id AS quoteId, o.snapshot, q.snapshot AS quoteSnapshot,
       q.owner_hash AS quoteOwner, q.expires_at AS quoteExpiresAt, q.created_at AS quoteCreatedAt,
       o.created_at AS createdAt, o.state, o.payment_state AS paymentState, o.fulfillment,
       o.reserve_until AS reserveUntil, o.version FROM commerce_orders o
       JOIN commerce_quotes q ON q.id = o.quote_id WHERE ${
         owned
           ? `EXISTS (SELECT 1 FROM commerce_checkout_order_origins x
       JOIN commerce_checkout_acceptances a ON a.acceptance_id=x.acceptance_id
       JOIN commerce_checkout_quotes cq ON cq.quote_id=x.checkout_quote_id AND cq.quote_id=a.quote_id
       WHERE x.order_id=o.id AND x.promoted_quote_id=q.id AND x.command_id=o.reserve_command_id
       AND x.mode=? AND x.instance_id=? AND x.owner_hash=?
       AND a.mode=x.mode AND a.instance_id=x.instance_id AND a.owner_hash=x.owner_hash
       AND cq.mode=x.mode AND cq.instance_id=x.instance_id AND cq.owner_hash=x.owner_hash
       AND cq.rules_json=? AND cq.rules_hash=? AND x.rules_hash=cq.rules_hash
       AND o.snapshot=json_remove(cq.snapshot_json,'$.fixtureProfile'))`
           : `${legacyLabSource("order")} AND ${legacyLabSource("quote")}`
       } AND o.id = ? AND o.owner_hash = ?`,
    )
    .bind(
      ...(source.kind === "owned"
        ? [
            trusted.mode,
            trusted.instanceId,
            trusted.ownerHash,
            source.rulesJson,
            source.rulesHash,
          ]
        : []),
      id,
      trusted.ownerHash,
    )
    .first<Current>();
}
// Historical zero-tax lab quotes are fictional fixtures, not customer payable
// acceptance. The SQL trigger independently checks these values and all ledger lines.
function amount(
  order: Current,
  trusted: TrustedTestPaymentContext,
  input: TestPaymentStartInput,
  now: number,
  source: PaymentSource,
) {
  if (
    order.state !== "pending_payment" ||
    order.paymentState !== "not_started" ||
    order.fulfillment !== "none" ||
    order.version !== input.expectedVersion ||
    order.quoteOwner !== trusted.ownerHash ||
    order.snapshot !== order.quoteSnapshot ||
    !safe(order.createdAt) ||
    order.createdAt > now ||
    !safe(order.quoteCreatedAt) ||
    order.quoteCreatedAt > now ||
    !safe(order.reserveUntil) ||
    order.reserveUntil <= now ||
    order.reserveUntil > maxDate ||
    !safe(order.quoteExpiresAt) ||
    order.quoteExpiresAt <= now ||
    order.quoteExpiresAt > maxDate
  )
    return null;
  let quote: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(order.snapshot);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    quote = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (
    quote.testOnly !== true ||
    quote.currency !== "CAD" ||
    quote.rulesVersion !==
      (source.kind === "owned" ? ownedRulesVersion : "local-test-v1") ||
    quote.expiresAt !== order.quoteExpiresAt ||
    !Array.isArray(quote.lines) ||
    quote.lines.length < 1 ||
    quote.lines.length > 20 ||
    !safe(quote.subtotalCents) ||
    !safe(quote.shippingCents) ||
    !safe(quote.taxCents) ||
    (source.kind === "legacy"
      ? quote.taxCents !== 0
      : quote.contractVersion !== "local-checkout-v1" ||
        quote.taxBasisPoints !== 1000 ||
        quote.taxBaseCents !== quote.subtotalCents + quote.shippingCents ||
        quote.taxCents !==
          Number(
            (BigInt(quote.subtotalCents + quote.shippingCents) * 1000n +
              5000n) /
              10000n,
          )) ||
    !safe(quote.totalCents, 1) ||
    quote.shippingCents !==
      (
        { pickup: 0, local_delivery: 500, shipping: 1500 } as Record<
          string,
          number
        >
      )[String(quote.delivery)] ||
    !["pickup", "local_delivery", "shipping"].includes(quote.delivery as string)
  )
    return null;
  let subtotal = 0;
  const ids = new Set<string>();
  for (const line of quote.lines as unknown[]) {
    if (!line || typeof line !== "object" || Array.isArray(line)) return null;
    const item = line as Record<string, unknown>;
    if (
      typeof item.variantId !== "string" ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(item.variantId) ||
      ids.has(item.variantId) ||
      !safe(item.quantity, 1) ||
      item.quantity > 20 ||
      !safe(item.unitPriceCents) ||
      !safe(item.version, 1) ||
      !safe(item.lineTotalCents) ||
      item.lineTotalCents !== item.quantity * item.unitPriceCents ||
      [item.sku, item.name, item.colour, item.sizeDescription].some(
        (value) => typeof value !== "string" || !value.trim(),
      )
    )
      return null;
    ids.add(item.variantId);
    subtotal += item.lineTotalCents;
    if (!safe(subtotal)) return null;
  }
  return subtotal === quote.subtotalCents &&
    quote.totalCents === subtotal + quote.shippingCents + quote.taxCents
    ? quote.totalCents
    : null;
}

/** INTERNAL TEST ONLY. No runtime route/Worker imports this primitive. Trusted
 * callers must establish isolated local binding and owner authority first.
 * A recorded receipt means an intent/lock exists; no external request is sent.
 */
async function begin(
  db: D1Database,
  trusted: TrustedTestPaymentContext,
  input: TestPaymentStartInput,
  now: number,
  owned = false,
  clock?: () => number,
  beforeCommit?: () => Promise<void>,
): Promise<TestPaymentStartReceipt> {
  validate(trusted, input, now);
  // Bind this invocation to its confirmed values across asynchronous reads.
  trusted = { ...trusted };
  input = { ...input };
  const commandId = `payment-start-${input.requestId}`;
  const initialNow = now;
  let hookFailure: { error: unknown } | undefined;
  try {
    // No business-data reads happen until the explicit fixture binding matches.
    // This detects mistaken binding; a cloned DB can also clone this identifier.
    await assertScope(db, trusted);
    const witness = owned ? testCheckoutRulesWitness() : null;
    const source: PaymentSource = witness
      ? {
          kind: "owned",
          rulesJson: JSON.stringify(witness),
          rulesHash: await commandHash(witness),
        }
      : { kind: "legacy" };
    const hash = await commandHash({
      operation: owned
        ? "owned-checkout-payment-start-v1"
        : "test-payment-start-v1",
      requestId: input.requestId,
      reference: input.reference,
      expectedVersion: input.expectedVersion,
      mode: trusted.mode,
      instanceId: trusted.instanceId,
      provider: trusted.provider,
      accountRef: trusted.accountRef,
      ownerHash: trusted.ownerHash,
    });
    const replay = async (replayed = true) =>
      receipt(await previous(db, commandId), hash, trusted, input, replayed);
    const saved = await replay();
    if (saved) return saved;
    const order = await current(db, trusted, input.reference, source);
    const amountCents = order
      ? amount(order, trusted, input, now, source)
      : null;
    if (!order || amountCents === null) {
      // An identical call may have committed between receipt and order reads.
      const committed = await replay();
      if (committed) return committed;
      throw new PaymentStartError(order ? "conflict" : "not_found");
    }
    const snapshotHash = await commandHash({
      operation: "test-payment-snapshot-v1",
      snapshot: order.snapshot,
    });
    if (owned) {
      if (beforeCommit) {
        try {
          await beforeCommit();
        } catch (error) {
          hookFailure = { error };
          throw error;
        }
      }
      now = clock!();
      validate(trusted, input, now);
      if (
        now < initialNow ||
        amount(order, trusted, input, now, source) === null
      ) {
        const raced = await replay();
        if (raced) return raced;
        throw new PaymentStartError("conflict");
      }
    }
    try {
      await db.batch([
        db
          .prepare(
            "INSERT INTO commerce_commands(id, request_hash, created_at) VALUES (?, ?, ?)",
          )
          .bind(commandId, hash, now),
        db
          .prepare(
            `INSERT INTO commerce_payment_attempts(command_id, request_id, order_id, quote_id, owner_hash,
           mode, instance_id, provider, account_ref, amount_cents, currency, rules_version,
           snapshot_hash, expected_version, occurred_at, create_operation_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CAD', ?,
           (SELECT CASE WHEN snapshot = ? THEN ? END FROM commerce_orders WHERE ${owned ? "json_extract(snapshot,'$.rulesVersion')='fictional-checkout-acceptance-v1' AND json_extract(snapshot,'$.contractVersion')='local-checkout-v1'" : legacyLabSource()} AND id = ? AND owner_hash = ?), ?, ?, ?)`,
          )
          .bind(
            commandId,
            input.requestId,
            input.reference,
            order.quoteId,
            trusted.ownerHash,
            trusted.mode,
            trusted.instanceId,
            trusted.provider,
            trusted.accountRef,
            amountCents,
            owned ? ownedRulesVersion : "local-test-v1",
            order.snapshot,
            snapshotHash,
            input.reference,
            trusted.ownerHash,
            input.expectedVersion,
            now,
            crypto.randomUUID(),
          ),
        ...(owned
          ? [
              db
                .prepare(
                  `INSERT INTO commerce_commands(id,request_hash,created_at)
          SELECT NULL,NULL,NULL WHERE NOT EXISTS (
           SELECT 1 FROM commerce_payment_attempts a JOIN commerce_payment_work w ON w.attempt_command_id=a.command_id
           JOIN commerce_orders o ON o.id=a.order_id
           WHERE a.command_id=? AND a.order_id=? AND a.expected_version=?
           AND o.version=a.expected_version+1 AND o.state='pending_payment' AND o.payment_state='processing' AND o.fulfillment='none'
           AND w.version=1 AND w.next_operation='create' AND w.current_claim_id IS NULL
          )`,
                )
                .bind(commandId, input.reference, input.expectedVersion),
            ]
          : []),
      ]);
    } catch {
      const committed = await replay();
      if (committed) return committed;
      const latest = await current(db, trusted, input.reference, source);
      if (!latest || amount(latest, trusted, input, now, source) === null) {
        // Recheck after the second order-read gap as well (#48).
        const raced = await replay();
        if (raced) return raced;
        throw new PaymentStartError(latest ? "conflict" : "not_found");
      }
      // A trigger failure/readback cannot prove an uncertain request failed.
      throw new PaymentStartError("unavailable");
    }
    // Durable readback also protects against nonconforming zero-write adapters.
    const recorded = await replay(false);
    if (!recorded) throw new PaymentStartError("unavailable");
    return recorded;
  } catch (error) {
    if (hookFailure) throw hookFailure.error;
    if (error instanceof PaymentStartError) throw error;
    // Preserve the original request key on any inconclusive storage failure.
    throw new PaymentStartError("unavailable");
  }
}

/** Historical zero-tax lab entry point remains isolated and keeps its numeric clock API. */
export function beginTestPaymentAttempt(
  db: D1Database,
  trusted: TrustedTestPaymentContext,
  input: TestPaymentStartInput,
  now = Date.now(),
): Promise<TestPaymentStartReceipt> {
  return begin(db, trusted, input, now);
}

/** Owned preparation only. No provider request or permission to run the old simulator.
 * The caller hook may reauthorize immediately before a fresh millisecond clock sample;
 * its errors propagate unchanged and no business write follows a rejected hook. */
export async function beginOwnedCheckoutPaymentAttempt(
  db: D1Database,
  trusted: TrustedTestPaymentContext,
  input: TestPaymentStartInput,
  clock: () => number = Date.now,
  beforeCommit?: () => Promise<void>,
): Promise<TestPaymentStartReceipt> {
  const copy = <T>(value: T, keys: string[]): T => {
    if (!shape(value, keys)) throw new PaymentStartError("invalid_request");
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor))
        throw new PaymentStartError("invalid_request");
      result[key] = descriptor.value;
    }
    return result as T;
  };
  trusted = copy(trusted, [
    "mode",
    "instanceId",
    "provider",
    "accountRef",
    "ownerHash",
  ]);
  input = copy(input, ["requestId", "reference", "expectedVersion"]);
  if (
    trusted.provider !== "stripe" ||
    typeof clock !== "function" ||
    (beforeCommit !== undefined && typeof beforeCommit !== "function")
  )
    throw new PaymentStartError("invalid_request");
  return begin(db, trusted, input, clock(), true, clock, beforeCommit);
}
