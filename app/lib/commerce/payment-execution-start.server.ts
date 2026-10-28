import { commandHash } from "./inventory.server";

/** Internal fixture correlation only; this context is not authentication. */
export type TestPaymentExecutionContext = {
  mode: "local-test";
  instanceId: string;
  provider: "stripe" | "paypal";
  accountRef: string;
  workerId: string;
};
export type TestPaymentExecutionInput = {
  claimId: string;
  requestId: string;
  expectedVersion: number;
};
/** History only, including replayed=false. Never use a receipt to dispatch. */
export type TestPaymentExecutionReceipt = {
  testOnly: true;
  claimId: string;
  requestId: string;
  reference: string;
  provider: "stripe" | "paypal";
  operation: "create" | "query";
  expectedVersion: number;
  startedAt: number;
  replayed: boolean;
};
export class PaymentExecutionStartError extends Error {
  constructor(
    public readonly code:
      "invalid_request" | "not_found" | "conflict" | "unavailable",
  ) {
    super("Local test payment execution registration could not be confirmed");
    this.name = "PaymentExecutionStartError";
  }
}
type Source = {
  claimId: string;
  attemptId: string;
  workerId: string;
  mode: string;
  instanceId: string;
  provider: string;
  accountRef: string;
  claimVersion: number;
  operation: "create" | "query";
  claimedAt: number;
  leaseUntil: number;
  requestId: string;
  reference: string;
  attemptMode: string;
  attemptInstance: string;
  attemptProvider: string;
  attemptAccount: string;
  occurredAt: number;
};
type Saved = {
  claimId: string;
  attemptId: string;
  workerId: string;
  mode: string;
  instanceId: string;
  provider: string;
  accountRef: string;
  expectedVersion: number;
  operation: string;
  requestHash: string;
  startedAt: number;
};
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fixture = /^fixture-[A-Za-z0-9_-]{1,92}$/;
const maxDate = 8_640_000_000_000_000;
function shape(value: unknown, keys: string[]): boolean {
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
function safe(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}
function sample(clock: () => number): number {
  if (typeof clock !== "function")
    throw new PaymentExecutionStartError("invalid_request");
  const now = clock();
  if (!safe(now) || now > maxDate)
    throw new PaymentExecutionStartError("invalid_request");
  return now;
}
function normalized(
  trusted: TestPaymentExecutionContext,
  input: TestPaymentExecutionInput,
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
    throw new PaymentExecutionStartError("invalid_request");
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
    !fixture.test(context.accountRef) ||
    typeof command.claimId !== "string" ||
    !uuid.test(command.claimId) ||
    typeof command.requestId !== "string" ||
    !uuid.test(command.requestId) ||
    !safe(command.expectedVersion, 2)
  )
    throw new PaymentExecutionStartError("invalid_request");
  return { context, command };
}
/**
 * Records one synthetic start per current claim. No executor, provider or route.
 * Acknowledged fresh insertion and recovered history are distinguished, but
 * neither return value is a reusable sending capability. A future executor must
 * own registration and recheck its clock immediately before its adapter call.
 */
export async function registerTestPaymentExecution(
  db: D1Database,
  trusted: TestPaymentExecutionContext,
  input: TestPaymentExecutionInput,
  clock: () => number = Date.now,
): Promise<TestPaymentExecutionReceipt> {
  const { context, command } = normalized(trusted, input);
  try {
    const initialTime = sample(clock);
    const scope = await db
      .prepare(
        "SELECT mode,instance_id AS instanceId,stripe_account_ref AS stripeAccountRef,paypal_account_ref AS paypalAccountRef FROM commerce_payment_scope WHERE id=1",
      )
      .first<{
        mode: string;
        instanceId: string;
        stripeAccountRef: string;
        paypalAccountRef: string;
      }>();
    if (
      !scope ||
      scope.mode !== context.mode ||
      scope.instanceId !== context.instanceId ||
      context.accountRef !==
        (context.provider === "stripe"
          ? scope.stripeAccountRef
          : scope.paypalAccountRef)
    )
      throw new PaymentExecutionStartError("unavailable");
    const source = await db
      .prepare(
        `SELECT c.claim_id AS claimId,c.attempt_command_id AS attemptId,c.worker_id AS workerId,
        c.mode,c.instance_id AS instanceId,c.provider,c.account_ref AS accountRef,
        c.expected_version AS claimVersion,c.kind AS operation,c.claimed_at AS claimedAt,c.lease_until AS leaseUntil,
        a.request_id AS requestId,a.order_id AS reference,a.mode AS attemptMode,a.instance_id AS attemptInstance,
        a.provider AS attemptProvider,a.account_ref AS attemptAccount,a.occurred_at AS occurredAt
       FROM commerce_payment_work_claims c LEFT JOIN commerce_payment_attempts a ON a.command_id=c.attempt_command_id
       WHERE c.claim_id=?`,
      )
      .bind(command.claimId)
      .first<Source>();
    if (!source) throw new PaymentExecutionStartError("not_found");
    if (
      source.claimId !== command.claimId ||
      source.attemptId !== `payment-start-${command.requestId}` ||
      source.workerId !== context.workerId ||
      source.mode !== context.mode ||
      source.instanceId !== context.instanceId ||
      source.provider !== context.provider ||
      source.accountRef !== context.accountRef ||
      source.requestId !== command.requestId ||
      source.attemptMode !== context.mode ||
      source.attemptInstance !== context.instanceId ||
      source.attemptProvider !== context.provider ||
      source.attemptAccount !== context.accountRef ||
      !safe(source.claimVersion, 1) ||
      source.claimVersion >= Number.MAX_SAFE_INTEGER ||
      source.claimVersion + 1 !== command.expectedVersion ||
      !["create", "query"].includes(source.operation) ||
      !safe(source.claimedAt) ||
      source.claimedAt > maxDate - 30_000 ||
      source.leaseUntil !== source.claimedAt + 30_000 ||
      !safe(source.occurredAt) ||
      source.occurredAt > source.claimedAt ||
      typeof source.reference !== "string" ||
      !source.reference.startsWith("order-") ||
      !uuid.test(source.reference.slice(6))
    )
      throw new PaymentExecutionStartError("conflict");
    if (initialTime < source.claimedAt)
      throw new PaymentExecutionStartError("conflict");
    const hash = await commandHash({
      operation: "test-payment-execution-start-v1",
      mode: context.mode,
      instanceId: context.instanceId,
      provider: context.provider,
      accountRef: context.accountRef,
      workerId: context.workerId,
      claimId: command.claimId,
      requestId: command.requestId,
      expectedVersion: command.expectedVersion,
    });
    const read = async (
      replayed: boolean,
    ): Promise<TestPaymentExecutionReceipt | null> => {
      const saved = await db
        .prepare(
          `SELECT claim_id AS claimId,attempt_command_id AS attemptId,worker_id AS workerId,mode,
          instance_id AS instanceId,provider,account_ref AS accountRef,expected_work_version AS expectedVersion,
          operation,request_hash AS requestHash,started_at AS startedAt
         FROM commerce_payment_execution_starts WHERE claim_id=?`,
        )
        .bind(command.claimId)
        .first<Saved>();
      if (!saved) return null;
      if (
        saved.claimId !== command.claimId ||
        saved.attemptId !== source.attemptId ||
        saved.workerId !== context.workerId ||
        saved.mode !== context.mode ||
        saved.instanceId !== context.instanceId ||
        saved.provider !== context.provider ||
        saved.accountRef !== context.accountRef ||
        saved.expectedVersion !== command.expectedVersion ||
        saved.operation !== source.operation ||
        saved.requestHash !== hash ||
        !safe(saved.startedAt) ||
        saved.startedAt < source.claimedAt ||
        saved.startedAt >= source.leaseUntil
      )
        throw new PaymentExecutionStartError("conflict");
      return {
        testOnly: true,
        claimId: command.claimId,
        requestId: command.requestId,
        reference: source.reference,
        provider: context.provider,
        operation: source.operation,
        expectedVersion: command.expectedVersion,
        startedAt: saved.startedAt,
        replayed,
      };
    };
    const prior = await read(true);
    if (prior) return prior;
    // Re-sample AFTER async scope/proof/hash/receipt preparation. SQL repeats
    // mutable eligibility using this timestamp; it is not a DB wall-clock fence.
    const startedAt = sample(clock);
    if (startedAt < initialTime || startedAt < source.claimedAt)
      throw new PaymentExecutionStartError("conflict");
    let acknowledged = false;
    try {
      const results = await db.batch([
        db
          .prepare(
            `INSERT INTO commerce_payment_execution_starts
          (claim_id,attempt_command_id,worker_id,mode,instance_id,provider,account_ref,expected_work_version,operation,request_hash,started_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .bind(
            command.claimId,
            source.attemptId,
            context.workerId,
            context.mode,
            context.instanceId,
            context.provider,
            context.accountRef,
            command.expectedVersion,
            source.operation,
            hash,
            startedAt,
          ),
      ]);
      acknowledged =
        results.length === 1 &&
        results[0].success === true &&
        results[0].meta?.changes === 1;
    } catch {
      const recovered = await read(true);
      if (recovered) return recovered;
      // Source/currency amounts are immutable; stale eligibility is a conflict,
      // transport/storage rejection without such evidence stays unavailable.
      const state = await db
        .prepare(
          `SELECT w.current_claim_id AS claimId,w.version,c.lease_until AS leaseUntil
         FROM commerce_payment_work w JOIN commerce_payment_work_claims c ON c.claim_id=w.current_claim_id
         WHERE w.attempt_command_id=?`,
        )
        .bind(source.attemptId)
        .first<{ claimId: string; version: number; leaseUntil: number }>();
      const raced = await read(true);
      if (raced) return raced;
      if (
        !state ||
        state.claimId !== command.claimId ||
        state.version !== command.expectedVersion ||
        startedAt >= source.leaseUntil
      )
        throw new PaymentExecutionStartError("conflict");
      throw new PaymentExecutionStartError("unavailable");
    }
    const stored = await read(!acknowledged);
    if (!stored || (!stored.replayed && stored.startedAt !== startedAt))
      throw new PaymentExecutionStartError("unavailable");
    return stored;
  } catch (error) {
    if (error instanceof PaymentExecutionStartError) throw error;
    throw new PaymentExecutionStartError("unavailable");
  }
}
