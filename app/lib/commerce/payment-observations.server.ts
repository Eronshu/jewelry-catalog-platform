import { commandHash } from "./inventory.server";

export class PaymentObservationError extends Error {
  constructor(
    public readonly code:
      "invalid_request" | "not_found" | "conflict" | "unavailable",
  ) {
    super("Local test payment observation could not be confirmed");
    this.name = "PaymentObservationError";
  }
}
export type TestPaymentObservationContext = {
  mode: "local-test";
  instanceId: string;
  provider: "stripe" | "paypal";
  accountRef: string;
  workerId: string;
};
type ObservationKind =
  | "unknown"
  | "not_found"
  | "pending"
  | "approved"
  | "reported_failed"
  | "captured";
type Capture = {
  transactionRef: string;
  amountCents: number;
  currency: string;
};
export type TestPaymentObservationInput = {
  observationId: string;
  requestId: string;
  claimId: string;
  kind: ObservationKind;
  providerObjectRef: string | null;
  capture: Capture | null;
};
/** Synthetic normalized history only; no verification, dispatch or business authority. */
export type TestPaymentObservationReceipt = {
  testOnly: true;
  observationId: string;
  requestId: string;
  sourceClaimId: string;
  reference: string;
  provider: "stripe" | "paypal";
  kind: ObservationKind;
  providerObjectRef: string | null;
  capture: Capture | null;
  recordedAt: number;
  replayed: boolean;
};
type Scope = {
  mode: string;
  instanceId: string;
  stripeAccountRef: string;
  paypalAccountRef: string;
};
type Proof = {
  commandId: string;
  requestId: string;
  reference: string;
  mode: string;
  instanceId: string;
  provider: string;
  accountRef: string;
  claimMode: string;
  claimInstanceId: string;
  claimProvider: string;
  claimAccountRef: string;
  workerId: string;
  claimedAt: number;
  occurredAt: number;
};
type Saved = {
  observationId: string;
  attemptCommandId: string;
  sourceClaimId: string;
  sourceWorkerId: string;
  mode: string;
  instanceId: string;
  provider: string;
  accountRef: string;
  kind: string;
  providerObjectRef: string | null;
  transactionRef: string | null;
  amountCents: number | null;
  currency: string | null;
  requestHash: string;
  recordedAt: number;
};
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fixtureRef = /^fixture-[A-Za-z0-9_-]{1,92}$/;
const kinds: readonly ObservationKind[] = [
  "unknown",
  "not_found",
  "pending",
  "approved",
  "reported_failed",
  "captured",
];
const maxDate = 8_640_000_000_000_000;
function safe(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}
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
function normalized(
  trusted: TestPaymentObservationContext,
  input: TestPaymentObservationInput,
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
    !shape(input, [
      "observationId",
      "requestId",
      "claimId",
      "kind",
      "providerObjectRef",
      "capture",
    ]) ||
    (input.capture !== null &&
      !shape(input.capture, ["transactionRef", "amountCents", "currency"]))
  )
    throw new PaymentObservationError("invalid_request");
  // Own data values, including nested capture, are copied before the first await.
  // Fixed property order also makes hashes independent of input insertion order.
  const context = {
    mode: trusted.mode,
    instanceId: trusted.instanceId,
    provider: trusted.provider,
    accountRef: trusted.accountRef,
    workerId: trusted.workerId,
  };
  const observation = {
    observationId: input.observationId,
    requestId: input.requestId,
    claimId: input.claimId,
    kind: input.kind,
    providerObjectRef: input.providerObjectRef,
    capture:
      input.capture === null
        ? null
        : {
            transactionRef: input.capture.transactionRef,
            amountCents: input.capture.amountCents,
            currency: input.capture.currency,
          },
  };
  const captured = observation.capture;
  if (
    context.mode !== "local-test" ||
    !["stripe", "paypal"].includes(context.provider) ||
    typeof context.instanceId !== "string" ||
    !uuid.test(context.instanceId) ||
    typeof context.workerId !== "string" ||
    !uuid.test(context.workerId) ||
    typeof context.accountRef !== "string" ||
    !fixtureRef.test(context.accountRef) ||
    typeof observation.observationId !== "string" ||
    !uuid.test(observation.observationId) ||
    typeof observation.requestId !== "string" ||
    !uuid.test(observation.requestId) ||
    typeof observation.claimId !== "string" ||
    !uuid.test(observation.claimId) ||
    !kinds.includes(observation.kind) ||
    (observation.providerObjectRef !== null &&
      (typeof observation.providerObjectRef !== "string" ||
        !fixtureRef.test(observation.providerObjectRef))) ||
    (observation.kind === "captured"
      ? captured === null || observation.providerObjectRef === null
      : captured !== null) ||
    (["pending", "approved", "reported_failed"].includes(observation.kind) &&
      observation.providerObjectRef === null) ||
    (captured !== null &&
      (typeof captured.transactionRef !== "string" ||
        !fixtureRef.test(captured.transactionRef) ||
        !safe(captured.amountCents, 1) ||
        typeof captured.currency !== "string" ||
        !/^[A-Z]{3}$/.test(captured.currency))) ||
    !safe(now) ||
    now > maxDate
  )
    throw new PaymentObservationError("invalid_request");
  return { context, observation };
}
async function assertScope(
  db: D1Database,
  context: TestPaymentObservationContext,
) {
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
    throw new PaymentObservationError("unavailable");
}
async function proof(
  db: D1Database,
  context: TestPaymentObservationContext,
  input: TestPaymentObservationInput,
  now: number,
) {
  const saved = await db
    .prepare(
      `SELECT a.command_id AS commandId,a.request_id AS requestId,a.order_id AS reference,
    a.mode,a.instance_id AS instanceId,a.provider,a.account_ref AS accountRef,
    c.mode AS claimMode,c.instance_id AS claimInstanceId,c.provider AS claimProvider,c.account_ref AS claimAccountRef,
    c.worker_id AS workerId,c.claimed_at AS claimedAt,a.occurred_at AS occurredAt
    FROM commerce_payment_work_claims c JOIN commerce_payment_attempts a ON a.command_id=c.attempt_command_id
    WHERE c.claim_id=?`,
    )
    .bind(input.claimId)
    .first<Proof>();
  if (!saved) throw new PaymentObservationError("not_found");
  if (
    saved.commandId !== `payment-start-${input.requestId}` ||
    saved.requestId !== input.requestId ||
    saved.mode !== context.mode ||
    saved.claimMode !== context.mode ||
    saved.instanceId !== context.instanceId ||
    saved.claimInstanceId !== context.instanceId ||
    saved.provider !== context.provider ||
    saved.claimProvider !== context.provider ||
    saved.accountRef !== context.accountRef ||
    saved.claimAccountRef !== context.accountRef ||
    saved.workerId !== context.workerId ||
    !safe(saved.claimedAt) ||
    saved.claimedAt > now ||
    !safe(saved.occurredAt) ||
    saved.occurredAt > now ||
    saved.claimedAt < saved.occurredAt ||
    typeof saved.reference !== "string" ||
    !/^order-[a-f0-9-]{36}$/.test(saved.reference)
  )
    throw new PaymentObservationError("conflict");
  // Immutable historical proof, not current permission to send. Lease/order state
  // changes cannot discard late evidence. A real adapter must establish trust.
  return saved;
}
function previous(db: D1Database, id: string) {
  return db
    .prepare(
      `SELECT observation_id AS observationId,attempt_command_id AS attemptCommandId,
    source_claim_id AS sourceClaimId,source_worker_id AS sourceWorkerId,mode,instance_id AS instanceId,
    provider,account_ref AS accountRef,kind,provider_object_ref AS providerObjectRef,
    transaction_ref AS transactionRef,amount_cents AS amountCents,currency,request_hash AS requestHash,recorded_at AS recordedAt
    FROM commerce_payment_observations WHERE observation_id=?`,
    )
    .bind(id)
    .first<Saved>();
}
function receipt(
  saved: Saved | null,
  hash: string,
  context: TestPaymentObservationContext,
  input: TestPaymentObservationInput,
  proven: Proof,
  replayed: boolean,
): TestPaymentObservationReceipt | null {
  if (!saved) return null;
  if (
    saved.observationId !== input.observationId ||
    saved.requestHash !== hash ||
    saved.attemptCommandId !== proven.commandId ||
    saved.sourceClaimId !== input.claimId ||
    saved.sourceWorkerId !== context.workerId ||
    saved.mode !== context.mode ||
    saved.instanceId !== context.instanceId ||
    saved.provider !== context.provider ||
    saved.accountRef !== context.accountRef ||
    saved.kind !== input.kind ||
    saved.providerObjectRef !== input.providerObjectRef ||
    saved.transactionRef !== (input.capture?.transactionRef ?? null) ||
    saved.amountCents !== (input.capture?.amountCents ?? null) ||
    saved.currency !== (input.capture?.currency ?? null) ||
    !safe(saved.recordedAt) ||
    saved.recordedAt > maxDate
  )
    throw new PaymentObservationError("conflict");
  return {
    testOnly: true,
    observationId: saved.observationId,
    requestId: input.requestId,
    sourceClaimId: saved.sourceClaimId,
    reference: proven.reference,
    provider: context.provider,
    kind: input.kind,
    providerObjectRef: saved.providerObjectRef,
    capture: input.capture === null ? null : { ...input.capture },
    recordedAt: saved.recordedAt,
    replayed,
  };
}
/** INTERNAL SYNTHETIC LOCAL TEST ONLY. No routes, provider calls or processing.
 * approved is not capture; not_found is not proof of no charge; reported_failed
 * does not end the order or permit releasing stock. Captured observations do not
 * automatically create economic facts. This journal is not a verified inbox.
 */
export async function recordTestPaymentObservation(
  db: D1Database,
  trusted: TestPaymentObservationContext,
  input: TestPaymentObservationInput,
  now = Date.now(),
): Promise<TestPaymentObservationReceipt> {
  try {
    const { context, observation } = normalized(trusted, input, now);
    await assertScope(db, context);
    const proven = await proof(db, context, observation, now);
    const hash = await commandHash({
      operation: "test-payment-observation-v1",
      context,
      input: observation,
    });
    const read = (replayed: boolean) =>
      previous(db, observation.observationId).then((saved) =>
        receipt(saved, hash, context, observation, proven, replayed),
      );
    const prior = await read(true);
    if (prior) return prior;
    try {
      await db.batch([
        db
          .prepare(
            `INSERT INTO commerce_payment_observations
        (observation_id,attempt_command_id,source_claim_id,source_worker_id,mode,instance_id,provider,account_ref,
        kind,provider_object_ref,transaction_ref,amount_cents,currency,request_hash,recorded_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .bind(
            observation.observationId,
            proven.commandId,
            observation.claimId,
            context.workerId,
            context.mode,
            context.instanceId,
            context.provider,
            context.accountRef,
            observation.kind,
            observation.providerObjectRef,
            observation.capture?.transactionRef ?? null,
            observation.capture?.amountCents ?? null,
            observation.capture?.currency ?? null,
            hash,
            now,
          ),
      ]);
    } catch {
      const recovered = await read(true);
      if (recovered) return recovered;
      throw new PaymentObservationError("unavailable");
    }
    const stored = await read(false);
    if (!stored) throw new PaymentObservationError("unavailable");
    return stored;
  } catch (error) {
    if (error instanceof PaymentObservationError) throw error;
    throw new PaymentObservationError("unavailable");
  }
}
