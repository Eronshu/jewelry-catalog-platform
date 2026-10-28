import { captureFactDescriptor } from "./capture-fact-descriptor.server";
import { commandHash } from "./inventory.server";

export class PaymentProcessingError extends Error {
  constructor(
    public readonly code:
      "invalid_request" | "not_found" | "conflict" | "unavailable",
  ) {
    super("Local test payment processing could not be confirmed");
    this.name = "PaymentProcessingError";
  }
}
/** Internal processing context, not authentication or a source-worker identity. */
export type TestPaymentProcessingContext = {
  mode: "local-test";
  instanceId: string;
  provider: "stripe" | "paypal";
  accountRef: string;
};
export type TestPaymentProcessingInput = { observationId: string };
type Kind =
  | "unknown"
  | "not_found"
  | "pending"
  | "approved"
  | "reported_failed"
  | "captured";
type Outcome = "observation_only" | "capture_fact" | "capture_conflict";
/** Synthetic history only. Neither amount matching nor this receipt permits fulfillment. */
export type TestPaymentProcessingReceipt = {
  testOnly: true;
  observationId: string;
  requestId: string;
  reference: string;
  provider: "stripe" | "paypal";
  kind: Kind;
  outcome: Outcome;
  factId: string | null;
  amountMismatch: boolean;
  additionalCaptureAtProcessing: boolean;
  processedAt: number;
  replayed: boolean;
};
type Observation = {
  observation_id: string;
  attempt_command_id: string;
  source_claim_id: string;
  source_worker_id: string;
  mode: string;
  instance_id: string;
  provider: string;
  account_ref: string;
  kind: Kind;
  provider_object_ref: string | null;
  transaction_ref: string | null;
  amount_cents: number | null;
  currency: string | null;
  request_hash: string;
  recorded_at: number;
  requestId: string;
  reference: string;
  expectedAmount: number;
  expectedCurrency: string;
  attemptMode: string;
  attemptInstance: string;
  attemptProvider: string;
  attemptAccount: string;
  claimAttempt: string;
  claimWorker: string;
  claimMode: string;
  claimInstance: string;
  claimProvider: string;
  claimAccount: string;
  claimedAt: number;
  occurredAt: number;
};
type Result = {
  observation_id: string;
  attempt_command_id: string;
  mode: string;
  instance_id: string;
  provider: string;
  account_ref: string;
  request_hash: string;
  outcome: Outcome;
  fact_id: string | null;
  candidate_fact_id: string | null;
  payload_hash: string | null;
  amount_mismatch: number;
  additional_capture_at_processing: number;
  processed_at: number;
};
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fixture = /^fixture-[A-Za-z0-9_-]{1,92}$/;
const kinds: readonly Kind[] = [
  "unknown",
  "not_found",
  "pending",
  "approved",
  "reported_failed",
  "captured",
];
const maxDate = 8_640_000_000_000_000;
function integer(value: unknown, minimum = 0): value is number {
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
  trusted: TestPaymentProcessingContext,
  input: TestPaymentProcessingInput,
  now: number,
) {
  if (
    !shape(trusted, ["mode", "instanceId", "provider", "accountRef"]) ||
    !shape(input, ["observationId"])
  )
    throw new PaymentProcessingError("invalid_request");
  // Copy own data values in fixed order before any await, without invoking getters.
  const context = {
    mode: trusted.mode,
    instanceId: trusted.instanceId,
    provider: trusted.provider,
    accountRef: trusted.accountRef,
  };
  const observationId = input.observationId;
  if (
    context.mode !== "local-test" ||
    !["stripe", "paypal"].includes(context.provider) ||
    typeof context.instanceId !== "string" ||
    !uuid.test(context.instanceId) ||
    typeof context.accountRef !== "string" ||
    !fixture.test(context.accountRef) ||
    typeof observationId !== "string" ||
    !uuid.test(observationId) ||
    !integer(now) ||
    now > maxDate
  )
    throw new PaymentProcessingError("invalid_request");
  return { context, observationId };
}
async function assertScope(
  db: D1Database,
  context: TestPaymentProcessingContext,
) {
  const scope = await db
    .prepare("SELECT * FROM commerce_payment_scope WHERE id=1")
    .first<{
      mode: string;
      instance_id: string;
      stripe_account_ref: string;
      paypal_account_ref: string;
    }>();
  if (
    !scope ||
    scope.mode !== context.mode ||
    scope.instance_id !== context.instanceId ||
    context.accountRef !==
      (context.provider === "stripe"
        ? scope.stripe_account_ref
        : scope.paypal_account_ref)
  )
    throw new PaymentProcessingError("unavailable");
}
async function source(
  db: D1Database,
  context: TestPaymentProcessingContext,
  observationId: string,
  now: number,
) {
  const o = await db
    .prepare(
      `SELECT o.*,a.request_id AS requestId,a.order_id AS reference,
      a.amount_cents AS expectedAmount,a.currency AS expectedCurrency,
      a.mode AS attemptMode,a.instance_id AS attemptInstance,a.provider AS attemptProvider,a.account_ref AS attemptAccount,
      c.attempt_command_id AS claimAttempt,c.worker_id AS claimWorker,c.mode AS claimMode,
      c.instance_id AS claimInstance,c.provider AS claimProvider,c.account_ref AS claimAccount,
      c.claimed_at AS claimedAt,a.occurred_at AS occurredAt
      FROM commerce_payment_observations o
      JOIN commerce_payment_attempts a ON a.command_id=o.attempt_command_id
      JOIN commerce_payment_work_claims c ON c.claim_id=o.source_claim_id WHERE o.observation_id=?`,
    )
    .bind(observationId)
    .first<Observation>();
  if (!o) throw new PaymentProcessingError("not_found");
  if (
    o.observation_id !== observationId ||
    o.mode !== context.mode ||
    o.instance_id !== context.instanceId ||
    o.provider !== context.provider ||
    o.account_ref !== context.accountRef ||
    o.attemptMode !== context.mode ||
    o.attemptInstance !== context.instanceId ||
    o.attemptProvider !== context.provider ||
    o.attemptAccount !== context.accountRef ||
    o.claimMode !== context.mode ||
    o.claimInstance !== context.instanceId ||
    o.claimProvider !== context.provider ||
    o.claimAccount !== context.accountRef ||
    o.claimAttempt !== o.attempt_command_id ||
    o.claimWorker !== o.source_worker_id ||
    typeof o.source_worker_id !== "string" ||
    !uuid.test(o.source_worker_id) ||
    typeof o.source_claim_id !== "string" ||
    !uuid.test(o.source_claim_id) ||
    typeof o.requestId !== "string" ||
    !uuid.test(o.requestId) ||
    o.attempt_command_id !== `payment-start-${o.requestId}` ||
    typeof o.reference !== "string" ||
    !o.reference.startsWith("order-") ||
    !uuid.test(o.reference.slice(6)) ||
    !integer(o.expectedAmount, 1) ||
    o.expectedCurrency !== "CAD" ||
    !integer(o.occurredAt) ||
    !integer(o.claimedAt) ||
    !integer(o.recorded_at) ||
    o.occurredAt > o.claimedAt ||
    o.claimedAt > o.recorded_at ||
    o.recorded_at > now ||
    !kinds.includes(o.kind) ||
    (o.provider_object_ref !== null &&
      (typeof o.provider_object_ref !== "string" ||
        !fixture.test(o.provider_object_ref))) ||
    (o.kind === "captured"
      ? o.provider_object_ref === null ||
        typeof o.transaction_ref !== "string" ||
        !fixture.test(o.transaction_ref) ||
        !integer(o.amount_cents, 1) ||
        typeof o.currency !== "string" ||
        !/^[A-Z]{3}$/.test(o.currency)
      : o.transaction_ref !== null ||
        o.amount_cents !== null ||
        o.currency !== null) ||
    (["pending", "approved", "reported_failed"].includes(o.kind) &&
      o.provider_object_ref === null)
  )
    throw new PaymentProcessingError("conflict");
  // Reconstruct original source binding. Processing never impersonates its worker.
  const hash = await commandHash({
    operation: "test-payment-observation-v1",
    context: { ...context, workerId: o.source_worker_id },
    input: {
      observationId,
      requestId: o.requestId,
      claimId: o.source_claim_id,
      kind: o.kind,
      providerObjectRef: o.provider_object_ref,
      capture:
        o.kind === "captured"
          ? {
              transactionRef: o.transaction_ref,
              amountCents: o.amount_cents,
              currency: o.currency,
            }
          : null,
    },
  });
  if (o.request_hash !== hash) throw new PaymentProcessingError("conflict");
  return o;
}
// All related rows participate. A candidate-id collision and a natural-key match
// can be two different facts; any conflict wins, without first()/LIMIT selection.
const related = `(f.id=?1 OR (f.mode=o.mode AND f.instance_id=o.instance_id
  AND f.provider=o.provider AND f.account_ref=o.account_ref AND f.transaction_ref=o.transaction_ref))`;
const exact = `f.id=?1 AND f.payload_hash=?2 AND f.attempt_command_id=o.attempt_command_id
  AND f.mode=o.mode AND f.instance_id=o.instance_id AND f.provider=o.provider AND f.account_ref=o.account_ref
  AND f.provider_object_ref=o.provider_object_ref AND f.transaction_ref=o.transaction_ref
  AND f.actual_amount_cents=o.amount_cents AND f.actual_currency=o.currency
  AND f.expected_amount_cents=a.amount_cents AND f.expected_currency=a.currency
  AND f.amount_match=CASE WHEN o.amount_cents=a.amount_cents AND o.currency=a.currency THEN 'match' ELSE 'mismatch' END`;
const conflict = `EXISTS (SELECT 1 FROM commerce_payment_capture_facts f WHERE ${related} AND NOT (${exact}))`;
const additional = `(SELECT count(*) FROM commerce_payment_capture_facts f
  JOIN commerce_payment_attempts fa ON fa.command_id=f.attempt_command_id
  WHERE f.mode=o.mode AND f.instance_id=o.instance_id AND fa.order_id=a.order_id)>1`;

/** Internal synthetic processing only: no routes, provider calls or work completion. */
export async function processTestPaymentObservation(
  db: D1Database,
  trusted: TestPaymentProcessingContext,
  input: TestPaymentProcessingInput,
  now = Date.now(),
): Promise<TestPaymentProcessingReceipt> {
  try {
    const { context, observationId } = normalized(trusted, input, now);
    await assertScope(db, context);
    const o = await source(db, context, observationId, now);
    const descriptor =
      o.kind === "captured"
        ? await captureFactDescriptor(context, {
            attemptCommandId: o.attempt_command_id,
            reference: o.reference,
            providerObjectRef: o.provider_object_ref!,
            transactionRef: o.transaction_ref!,
            amountCents: o.amount_cents!,
            currency: o.currency!,
            expectedAmountCents: o.expectedAmount,
            expectedCurrency: o.expectedCurrency,
          })
        : null;
    const hash = await commandHash({
      operation: "test-payment-observation-processing-v1",
      context,
      observationId,
    });
    const amountMismatch = descriptor?.amountMatch === "mismatch";
    const read = async (
      replayed: boolean,
    ): Promise<TestPaymentProcessingReceipt | null> => {
      const r = await db
        .prepare(
          "SELECT * FROM commerce_payment_observation_results WHERE observation_id=?",
        )
        .bind(observationId)
        .first<Result>();
      if (!r) return null;
      if (
        r.observation_id !== observationId ||
        r.attempt_command_id !== o.attempt_command_id ||
        r.mode !== context.mode ||
        r.instance_id !== context.instanceId ||
        r.provider !== context.provider ||
        r.account_ref !== context.accountRef ||
        r.request_hash !== hash ||
        r.candidate_fact_id !== (descriptor?.id ?? null) ||
        r.payload_hash !== (descriptor?.payloadHash ?? null) ||
        r.amount_mismatch !== Number(amountMismatch) ||
        ![0, 1].includes(r.additional_capture_at_processing) ||
        !integer(r.processed_at) ||
        r.processed_at < o.recorded_at ||
        r.processed_at > maxDate ||
        (descriptor === null
          ? r.outcome !== "observation_only" ||
            r.fact_id !== null ||
            r.additional_capture_at_processing !== 0
          : r.outcome === "capture_fact"
            ? r.fact_id !== descriptor.id
            : r.outcome !== "capture_conflict" ||
              r.fact_id !== null ||
              r.additional_capture_at_processing !== 0)
      )
        throw new PaymentProcessingError("conflict");
      return {
        testOnly: true,
        observationId,
        requestId: o.requestId,
        reference: o.reference,
        provider: context.provider,
        kind: o.kind,
        outcome: r.outcome,
        factId: r.fact_id,
        amountMismatch,
        additionalCaptureAtProcessing: r.additional_capture_at_processing === 1,
        processedAt: r.processed_at,
        replayed,
      };
    };
    const prior = await read(true);
    if (prior) return prior;
    const statements: D1PreparedStatement[] = [];
    if (descriptor)
      statements.push(
        db
          .prepare(
            `INSERT INTO commerce_payment_capture_facts
            (id,attempt_command_id,source_claim_id,source_worker_id,mode,instance_id,provider,account_ref,
            provider_object_ref,transaction_ref,actual_amount_cents,actual_currency,expected_amount_cents,
            expected_currency,amount_match,payload_hash,recorded_at)
            SELECT ?1,o.attempt_command_id,o.source_claim_id,o.source_worker_id,o.mode,o.instance_id,o.provider,o.account_ref,
            o.provider_object_ref,o.transaction_ref,o.amount_cents,o.currency,a.amount_cents,a.currency,
            CASE WHEN o.amount_cents=a.amount_cents AND o.currency=a.currency THEN 'match' ELSE 'mismatch' END,?2,?3
            FROM commerce_payment_observations o JOIN commerce_payment_attempts a ON a.command_id=o.attempt_command_id
            WHERE o.observation_id=?4 AND o.kind='captured'
            AND NOT EXISTS (SELECT 1 FROM commerce_payment_capture_facts f WHERE ${related})`,
          )
          .bind(descriptor.id, descriptor.payloadHash, now, observationId),
      );
    statements.push(
      db
        .prepare(
          `INSERT INTO commerce_payment_observation_results
          (observation_id,attempt_command_id,mode,instance_id,provider,account_ref,request_hash,
          outcome,fact_id,candidate_fact_id,payload_hash,amount_mismatch,additional_capture_at_processing,processed_at)
          SELECT o.observation_id,o.attempt_command_id,o.mode,o.instance_id,o.provider,o.account_ref,?3,
          CASE WHEN o.kind<>'captured' THEN 'observation_only' WHEN ${conflict} THEN 'capture_conflict' ELSE 'capture_fact' END,
          CASE WHEN o.kind='captured' AND NOT (${conflict}) THEN ?1 ELSE NULL END,?1,?2,
          CASE WHEN o.kind='captured' AND (o.amount_cents<>a.amount_cents OR o.currency<>a.currency) THEN 1 ELSE 0 END,
          CASE WHEN o.kind='captured' AND NOT (${conflict}) AND ${additional} THEN 1 ELSE 0 END,?4
          FROM commerce_payment_observations o JOIN commerce_payment_attempts a ON a.command_id=o.attempt_command_id
          WHERE o.observation_id=?5 AND (o.kind<>'captured' OR EXISTS (
            SELECT 1 FROM commerce_payment_capture_facts f WHERE ${related}))`,
        )
        .bind(
          descriptor?.id ?? null,
          descriptor?.payloadHash ?? null,
          hash,
          now,
          observationId,
        ),
    );
    try {
      await db.batch(statements);
    } catch {
      const recovered = await read(true);
      if (recovered) return recovered;
      throw new PaymentProcessingError("unavailable");
    }
    const stored = await read(false);
    if (!stored) throw new PaymentProcessingError("unavailable");
    return stored;
  } catch (error) {
    if (error instanceof PaymentProcessingError) throw error;
    throw new PaymentProcessingError("unavailable");
  }
}
