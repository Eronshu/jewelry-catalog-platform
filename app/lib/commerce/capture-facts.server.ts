import { commandHash } from "./inventory.server";

export class CaptureFactError extends Error {
  constructor(
    public readonly code:
      "invalid_request" | "not_found" | "conflict" | "unavailable",
  ) {
    super("Local test capture fact could not be confirmed");
    this.name = "CaptureFactError";
  }
}
export type TestCaptureFactContext = {
  mode: "local-test";
  instanceId: string;
  provider: "stripe" | "paypal";
  accountRef: string;
  workerId: string;
};
export type TestCaptureFactInput = {
  requestId: string;
  claimId: string;
  providerObjectRef: string;
  transactionRef: string;
  amountCents: number;
  currency: string;
};
/** Synthetic economic history only, not verification or fulfillment permission. */
export type TestCaptureFactReceipt = {
  testOnly: true;
  factId: string;
  requestId: string;
  sourceClaimId: string;
  reference: string;
  provider: "stripe" | "paypal";
  providerObjectRef: string;
  transactionRef: string;
  actualAmountCents: number;
  actualCurrency: string;
  expectedAmountCents: number;
  expectedCurrency: "CAD";
  amountMatch: "match" | "mismatch";
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
  amountCents: number;
  currency: string;
};
type Saved = {
  id: string;
  attemptCommandId: string;
  sourceClaimId: string;
  mode: string;
  instanceId: string;
  provider: string;
  accountRef: string;
  providerObjectRef: string;
  transactionRef: string;
  actualAmountCents: number;
  actualCurrency: string;
  expectedAmountCents: number;
  expectedCurrency: string;
  amountMatch: string;
  payloadHash: string;
  recordedAt: number;
};
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fixtureRef = /^fixture-[A-Za-z0-9_-]{1,92}$/;
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
function capture(
  trusted: TestCaptureFactContext,
  input: TestCaptureFactInput,
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
      "requestId",
      "claimId",
      "providerObjectRef",
      "transactionRef",
      "amountCents",
      "currency",
    ])
  )
    throw new CaptureFactError("invalid_request");
  // Own data values are copied before any await; no accessor is invoked.
  const context = { ...trusted };
  const fact = { ...input };
  if (
    context.mode !== "local-test" ||
    !["stripe", "paypal"].includes(context.provider) ||
    typeof context.instanceId !== "string" ||
    !uuid.test(context.instanceId) ||
    typeof context.workerId !== "string" ||
    !uuid.test(context.workerId) ||
    typeof context.accountRef !== "string" ||
    !fixtureRef.test(context.accountRef) ||
    typeof fact.requestId !== "string" ||
    !uuid.test(fact.requestId) ||
    typeof fact.claimId !== "string" ||
    !uuid.test(fact.claimId) ||
    typeof fact.providerObjectRef !== "string" ||
    !fixtureRef.test(fact.providerObjectRef) ||
    typeof fact.transactionRef !== "string" ||
    !fixtureRef.test(fact.transactionRef) ||
    !safe(fact.amountCents, 1) ||
    typeof fact.currency !== "string" ||
    !/^[A-Z]{3}$/.test(fact.currency) ||
    !safe(now) ||
    now > maxDate
  )
    throw new CaptureFactError("invalid_request");
  return { context, fact };
}
async function assertScope(db: D1Database, context: TestCaptureFactContext) {
  const scope = await db
    .prepare(
      `SELECT mode,instance_id AS instanceId,
    stripe_account_ref AS stripeAccountRef,paypal_account_ref AS paypalAccountRef
    FROM commerce_payment_scope WHERE id=1`,
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
    throw new CaptureFactError("unavailable");
}
async function proof(
  db: D1Database,
  context: TestCaptureFactContext,
  input: TestCaptureFactInput,
  now: number,
): Promise<Proof> {
  const saved = await db
    .prepare(
      `SELECT a.command_id AS commandId,a.request_id AS requestId,
    a.order_id AS reference,a.mode,a.instance_id AS instanceId,a.provider,a.account_ref AS accountRef,
    c.mode AS claimMode,c.instance_id AS claimInstanceId,c.provider AS claimProvider,
    c.account_ref AS claimAccountRef,c.worker_id AS workerId,c.claimed_at AS claimedAt,
    a.occurred_at AS occurredAt,a.amount_cents AS amountCents,a.currency
    FROM commerce_payment_work_claims c JOIN commerce_payment_attempts a ON a.command_id=c.attempt_command_id
    WHERE c.claim_id=?`,
    )
    .bind(input.claimId)
    .first<Proof>();
  if (!saved) throw new CaptureFactError("not_found");
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
    !safe(saved.amountCents, 1) ||
    saved.currency !== "CAD" ||
    typeof saved.reference !== "string" ||
    !/^order-[a-f0-9-]{36}$/.test(saved.reference)
  )
    throw new CaptureFactError("conflict");
  // Historical immutable proof deliberately survives expired/replaced claims and
  // order state changes. This is not a fresh permission to contact a provider.
  return saved;
}
function previous(
  db: D1Database,
  id: string,
  context: TestCaptureFactContext,
  transactionRef: string,
) {
  return db
    .prepare(
      `SELECT id,attempt_command_id AS attemptCommandId,source_claim_id AS sourceClaimId,
    mode,instance_id AS instanceId,provider,account_ref AS accountRef,provider_object_ref AS providerObjectRef,
    transaction_ref AS transactionRef,actual_amount_cents AS actualAmountCents,actual_currency AS actualCurrency,
    expected_amount_cents AS expectedAmountCents,expected_currency AS expectedCurrency,
    amount_match AS amountMatch,payload_hash AS payloadHash,recorded_at AS recordedAt
    FROM commerce_payment_capture_facts WHERE id=? OR
    (mode=? AND instance_id=? AND provider=? AND account_ref=? AND transaction_ref=?)`,
    )
    .bind(
      id,
      context.mode,
      context.instanceId,
      context.provider,
      context.accountRef,
      transactionRef,
    )
    .first<Saved>();
}
function receipt(
  saved: Saved | null,
  id: string,
  hash: string,
  context: TestCaptureFactContext,
  input: TestCaptureFactInput,
  proven: Proof,
  replayed: boolean,
): TestCaptureFactReceipt | null {
  if (!saved) return null;
  const amountMatch =
    input.amountCents === proven.amountCents &&
    input.currency === proven.currency
      ? "match"
      : "mismatch";
  if (
    saved.id !== id ||
    saved.payloadHash !== hash ||
    saved.attemptCommandId !== proven.commandId ||
    saved.mode !== context.mode ||
    saved.instanceId !== context.instanceId ||
    saved.provider !== context.provider ||
    saved.accountRef !== context.accountRef ||
    saved.providerObjectRef !== input.providerObjectRef ||
    saved.transactionRef !== input.transactionRef ||
    saved.actualAmountCents !== input.amountCents ||
    saved.actualCurrency !== input.currency ||
    saved.expectedAmountCents !== proven.amountCents ||
    saved.expectedCurrency !== "CAD" ||
    saved.amountMatch !== amountMatch ||
    typeof saved.sourceClaimId !== "string" ||
    !uuid.test(saved.sourceClaimId) ||
    !safe(saved.recordedAt) ||
    saved.recordedAt > maxDate
  )
    throw new CaptureFactError("conflict");
  return {
    testOnly: true,
    factId: saved.id,
    requestId: input.requestId,
    sourceClaimId: saved.sourceClaimId,
    reference: proven.reference,
    provider: context.provider,
    providerObjectRef: saved.providerObjectRef,
    transactionRef: saved.transactionRef,
    actualAmountCents: saved.actualAmountCents,
    actualCurrency: saved.actualCurrency,
    expectedAmountCents: saved.expectedAmountCents,
    expectedCurrency: "CAD",
    amountMatch,
    recordedAt: saved.recordedAt,
    replayed,
  };
}
/** INTERNAL SYNTHETIC LOCAL TEST ONLY. No route, runner or provider calls this.
 * Records append-only economic observations, never verification or order state.
 */
export async function recordTestCaptureFact(
  db: D1Database,
  trusted: TestCaptureFactContext,
  input: TestCaptureFactInput,
  now = Date.now(),
): Promise<TestCaptureFactReceipt> {
  try {
    const { context, fact } = capture(trusted, input, now);
    await assertScope(db, context);
    // Always prove the current caller's historical claim before receipt lookup,
    // including replay by a different legitimate query worker.
    const proven = await proof(db, context, fact, now);
    const identity = {
      operation: "test-capture-identity-v1",
      mode: context.mode,
      instanceId: context.instanceId,
      provider: context.provider,
      accountRef: context.accountRef,
      transactionRef: fact.transactionRef,
    };
    const id = await commandHash(identity);
    const hash = await commandHash({
      operation: "test-capture-payload-v1",
      identity,
      attemptCommandId: proven.commandId,
      reference: proven.reference,
      providerObjectRef: fact.providerObjectRef,
      amountCents: fact.amountCents,
      currency: fact.currency,
      expectedAmountCents: proven.amountCents,
      expectedCurrency: proven.currency,
    });
    const read = (replayed: boolean) =>
      previous(db, id, context, fact.transactionRef).then((saved) =>
        receipt(saved, id, hash, context, fact, proven, replayed),
      );
    const prior = await read(true);
    if (prior) return prior;
    const amountMatch =
      fact.amountCents === proven.amountCents &&
      fact.currency === proven.currency
        ? "match"
        : "mismatch";
    try {
      await db.batch([
        db
          .prepare(
            `INSERT INTO commerce_payment_capture_facts
        (id,attempt_command_id,source_claim_id,source_worker_id,mode,instance_id,provider,account_ref,
        provider_object_ref,transaction_ref,actual_amount_cents,actual_currency,expected_amount_cents,
        expected_currency,amount_match,payload_hash,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .bind(
            id,
            proven.commandId,
            fact.claimId,
            context.workerId,
            context.mode,
            context.instanceId,
            context.provider,
            context.accountRef,
            fact.providerObjectRef,
            fact.transactionRef,
            fact.amountCents,
            fact.currency,
            proven.amountCents,
            "CAD",
            amountMatch,
            hash,
            now,
          ),
      ]);
    } catch {
      const recovered = await read(true);
      if (recovered) return recovered;
      throw new CaptureFactError("unavailable");
    }
    const stored = await read(false);
    if (!stored) throw new CaptureFactError("unavailable");
    return stored;
  } catch (error) {
    if (error instanceof CaptureFactError) throw error;
    throw new CaptureFactError("unavailable");
  }
}
