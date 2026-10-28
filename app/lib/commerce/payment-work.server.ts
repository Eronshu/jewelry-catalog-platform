import { commandHash } from "./inventory.server";

export class PaymentWorkError extends Error {
  constructor(
    public readonly code:
      "invalid_request" | "not_found" | "conflict" | "unavailable",
  ) {
    super("Local test payment work could not be confirmed");
    this.name = "PaymentWorkError";
  }
}
export type TestPaymentWorkContext = {
  mode: "local-test";
  instanceId: string;
  provider: "stripe" | "paypal";
  accountRef: string;
  workerId: string;
};
export type TestPaymentWorkClaimInput = {
  claimId: string;
  requestId: string;
  expectedVersion: number;
};
/** Immutable historical journal evidence, NEVER current permission to send. */
export type TestPaymentWorkClaimReceipt = {
  testOnly: true;
  claimId: string;
  requestId: string;
  reference: string;
  provider: "stripe" | "paypal";
  operation: "create" | "query";
  amountCents: number;
  currency: "CAD";
  createOperationKey: string;
  expectedVersion: number;
  resultingVersion: number;
  claimedAt: number;
  leaseUntil: number;
  replayed: boolean;
};
type Scope = {
  mode: string;
  instanceId: string;
  stripeAccountRef: string;
  paypalAccountRef: string;
};
type Saved = {
  claimId: string;
  requestHash: string;
  workerId: string;
  mode: string;
  instanceId: string;
  provider: "stripe" | "paypal";
  accountRef: string;
  expectedVersion: number;
  operation: "create" | "query";
  claimedAt: number;
  leaseUntil: number;
  requestId: string;
  reference: string;
  amountCents: number;
  currency: string;
  createOperationKey: string;
};
type Current = {
  version: number;
  nextOperation: string;
  currentClaimId: string | null;
  previousClaimedAt: number | null;
  previousLeaseUntil: number | null;
  occurredAt: number;
  state: string;
  paymentState: string;
  fulfillment: string;
  quoteExpiresAt: number;
  reserveUntil: number;
};
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const maxDate = 8_640_000_000_000_000;
const leaseMilliseconds = 30_000;
function safe(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}
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
    keys.every(
      (key) =>
        Object.hasOwn(value, key) &&
        "value" in Object.getOwnPropertyDescriptor(value, key)!,
    )
  );
}
function capture(
  trusted: TestPaymentWorkContext,
  input: TestPaymentWorkClaimInput,
  now: number,
) {
  if (
    !shape(trusted, [
      "mode",
      "instanceId",
      "provider",
      "accountRef",
      "workerId",
    ]) ||
    !shape(input, ["claimId", "requestId", "expectedVersion"])
  )
    throw new PaymentWorkError("invalid_request");
  // Copy validated own data properties before the first await; workerId is only
  // internal synthetic correlation, not authentication or a capability token.
  const context = { ...trusted };
  const command = { ...input };
  if (
    context.mode !== "local-test" ||
    !["stripe", "paypal"].includes(context.provider) ||
    typeof context.instanceId !== "string" ||
    !uuid.test(context.instanceId) ||
    typeof context.workerId !== "string" ||
    !uuid.test(context.workerId) ||
    typeof context.accountRef !== "string" ||
    !/^fixture-[A-Za-z0-9_-]{1,92}$/.test(context.accountRef) ||
    typeof command.claimId !== "string" ||
    !uuid.test(command.claimId) ||
    typeof command.requestId !== "string" ||
    !uuid.test(command.requestId) ||
    !safe(command.expectedVersion, 1) ||
    command.expectedVersion >= Number.MAX_SAFE_INTEGER ||
    !safe(now) ||
    now > maxDate - leaseMilliseconds
  )
    throw new PaymentWorkError("invalid_request");
  return { context, command };
}
async function assertScope(db: D1Database, context: TestPaymentWorkContext) {
  const scope = await db
    .prepare(
      `SELECT mode,instance_id AS instanceId,stripe_account_ref AS stripeAccountRef,
    paypal_account_ref AS paypalAccountRef FROM commerce_payment_scope WHERE id=1`,
    )
    .first<Scope>();
  if (
    !scope ||
    scope.mode !== context.mode ||
    scope.instanceId !== context.instanceId ||
    context.accountRef !==
      (context.provider === "stripe"
        ? scope.stripeAccountRef
        : scope.paypalAccountRef)
  )
    throw new PaymentWorkError("unavailable");
}
function previous(db: D1Database, id: string) {
  return db
    .prepare(
      `SELECT c.claim_id AS claimId,c.request_hash AS requestHash,c.worker_id AS workerId,
    c.mode,c.instance_id AS instanceId,c.provider,c.account_ref AS accountRef,c.expected_version AS expectedVersion,
    c.kind AS operation,c.claimed_at AS claimedAt,c.lease_until AS leaseUntil,
    a.request_id AS requestId,a.order_id AS reference,a.amount_cents AS amountCents,a.currency,
    a.create_operation_key AS createOperationKey
    FROM commerce_payment_work_claims c LEFT JOIN commerce_payment_attempts a ON a.command_id=c.attempt_command_id
    WHERE c.claim_id=?`,
    )
    .bind(id)
    .first<Saved>();
}
function receipt(
  saved: Saved | null,
  hash: string,
  context: TestPaymentWorkContext,
  input: TestPaymentWorkClaimInput,
  replayed: boolean,
): TestPaymentWorkClaimReceipt | null {
  if (!saved) return null;
  if (
    saved.claimId !== input.claimId ||
    saved.requestHash !== hash ||
    saved.workerId !== context.workerId ||
    saved.mode !== context.mode ||
    saved.instanceId !== context.instanceId ||
    saved.provider !== context.provider ||
    saved.accountRef !== context.accountRef ||
    saved.requestId !== input.requestId ||
    saved.expectedVersion !== input.expectedVersion ||
    !["create", "query"].includes(saved.operation) ||
    !safe(saved.amountCents, 1) ||
    saved.currency !== "CAD" ||
    !safe(saved.claimedAt) ||
    saved.claimedAt > maxDate - leaseMilliseconds ||
    saved.leaseUntil !== saved.claimedAt + leaseMilliseconds ||
    typeof saved.reference !== "string" ||
    !/^order-[a-f0-9-]{36}$/.test(saved.reference) ||
    typeof saved.createOperationKey !== "string" ||
    !uuid.test(saved.createOperationKey)
  )
    throw new PaymentWorkError("conflict");
  return {
    testOnly: true,
    claimId: input.claimId,
    requestId: input.requestId,
    reference: saved.reference,
    provider: context.provider,
    operation: saved.operation,
    amountCents: saved.amountCents,
    currency: "CAD",
    createOperationKey: saved.createOperationKey,
    expectedVersion: input.expectedVersion,
    resultingVersion: input.expectedVersion + 1,
    claimedAt: saved.claimedAt,
    leaseUntil: saved.leaseUntil,
    replayed,
  };
}
function current(
  db: D1Database,
  context: TestPaymentWorkContext,
  requestId: string,
) {
  return db
    .prepare(
      `SELECT w.version,w.next_operation AS nextOperation,w.current_claim_id AS currentClaimId,
    p.claimed_at AS previousClaimedAt,p.lease_until AS previousLeaseUntil,a.occurred_at AS occurredAt,
    o.state,o.payment_state AS paymentState,o.fulfillment,q.expires_at AS quoteExpiresAt,o.reserve_until AS reserveUntil
    FROM commerce_payment_work w JOIN commerce_payment_attempts a ON a.command_id=w.attempt_command_id
    JOIN commerce_orders o ON o.id=a.order_id JOIN commerce_quotes q ON q.id=a.quote_id
    LEFT JOIN commerce_payment_work_claims p ON p.claim_id=w.current_claim_id
    WHERE a.request_id=? AND a.mode=? AND a.instance_id=? AND a.provider=? AND a.account_ref=?`,
    )
    .bind(
      requestId,
      context.mode,
      context.instanceId,
      context.provider,
      context.accountRef,
    )
    .first<Current>();
}
function operation(
  work: Current,
  input: TestPaymentWorkClaimInput,
  now: number,
): "create" | "query" | null {
  if (
    work.version !== input.expectedVersion ||
    !["create", "query"].includes(work.nextOperation) ||
    !safe(work.occurredAt) ||
    work.occurredAt > now ||
    (work.currentClaimId !== null &&
      (!safe(work.previousClaimedAt) ||
        work.previousClaimedAt > now ||
        !safe(work.previousLeaseUntil) ||
        work.previousLeaseUntil > now))
  )
    return null;
  return work.nextOperation === "create" &&
    work.state === "pending_payment" &&
    work.paymentState === "processing" &&
    work.fulfillment === "none" &&
    work.quoteExpiresAt > now &&
    work.reserveUntil > now
    ? "create"
    : "query";
}
/** INTERNAL FICTIONAL LOCAL TEST ONLY. No route, runner or provider imports this.
 * A receipt is append-only history, not dispatch authority, even when replayed=false.
 * A future executor requires an independently reviewed fresh sending gate.
 */
export async function claimTestPaymentWork(
  db: D1Database,
  trusted: TestPaymentWorkContext,
  input: TestPaymentWorkClaimInput,
  now = Date.now(),
): Promise<TestPaymentWorkClaimReceipt> {
  const { context, command } = capture(trusted, input, now);
  try {
    await assertScope(db, context);
    const hash = await commandHash({
      operation: "test-payment-work-claim-v1",
      mode: context.mode,
      instanceId: context.instanceId,
      provider: context.provider,
      accountRef: context.accountRef,
      workerId: context.workerId,
      claimId: command.claimId,
      requestId: command.requestId,
      expectedVersion: command.expectedVersion,
    });
    const replay = async (replayed = true) =>
      receipt(
        await previous(db, command.claimId),
        hash,
        context,
        command,
        replayed,
      );
    const saved = await replay();
    if (saved) return saved;
    const work = await current(db, context, command.requestId);
    const kind = work ? operation(work, command, now) : null;
    if (!work || kind === null) {
      const committed = await replay();
      if (committed) return committed;
      throw new PaymentWorkError(work ? "conflict" : "not_found");
    }
    try {
      await db.batch([
        db
          .prepare(
            `INSERT INTO commerce_payment_work_claims(claim_id,attempt_command_id,worker_id,request_hash,
        mode,instance_id,provider,account_ref,expected_version,kind,claimed_at,lease_until)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .bind(
            command.claimId,
            `payment-start-${command.requestId}`,
            context.workerId,
            hash,
            context.mode,
            context.instanceId,
            context.provider,
            context.accountRef,
            command.expectedVersion,
            kind,
            now,
            now + leaseMilliseconds,
          ),
      ]);
    } catch {
      const committed = await replay();
      if (committed) return committed;
      const latest = await current(db, context, command.requestId);
      if (!latest || operation(latest, command, now) === null) {
        const raced = await replay();
        if (raced) return raced;
        throw new PaymentWorkError(latest ? "conflict" : "not_found");
      }
      throw new PaymentWorkError("unavailable");
    }
    const recorded = await replay(false);
    if (!recorded) throw new PaymentWorkError("unavailable");
    return recorded;
  } catch (error) {
    if (error instanceof PaymentWorkError) throw error;
    throw new PaymentWorkError("unavailable");
  }
}
