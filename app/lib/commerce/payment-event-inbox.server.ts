import { commandHash } from "./inventory.server";

export class PaymentEventInboxError extends Error {
  constructor(
    public readonly code: "invalid_request" | "conflict" | "unavailable",
  ) {
    super("Local test payment event receipt could not be confirmed");
    this.name = "PaymentEventInboxError";
  }
}
export type TestPaymentEventContext = {
  mode: "local-test";
  instanceId: string;
  provider: "stripe" | "paypal";
  accountRef: string;
};
export type TestPaymentEventInput = {
  eventRef: string;
  kind:
    | "unknown"
    | "not_found"
    | "pending"
    | "approved"
    | "reported_failed"
    | "captured"
    | "unmapped";
  providerObjectRef: string | null;
  candidateRequestId: string | null;
  capture: {
    transactionRef: string;
    amountCents: number;
    currency: string;
  } | null;
  occurredAt: number | null;
};
export type TestPaymentEventReceipt = {
  testOnly: true;
  receiptId: string;
  eventRef: string;
  receivedAt: number;
  replayed: boolean;
};
type Saved = {
  receiptId: string;
  mode: string;
  instanceId: string;
  provider: string;
  accountRef: string;
  eventRef: string;
  payloadHash: string;
  kind: string;
  providerObjectRef: string | null;
  candidateRequestId: string | null;
  transactionRef: string | null;
  amountCents: number | null;
  currency: string | null;
  occurredAt: number | null;
  receivedAt: number;
};
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fixtureRef = /^fixture-[A-Za-z0-9_-]{1,92}$/;
const maxDate = 8_640_000_000_000_000;
function date(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= maxDate
  );
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
  trusted: TestPaymentEventContext,
  input: TestPaymentEventInput,
  now: number,
) {
  if (
    !shape(trusted, ["mode", "instanceId", "provider", "accountRef"]) ||
    !shape(input, [
      "eventRef",
      "kind",
      "providerObjectRef",
      "candidateRequestId",
      "capture",
      "occurredAt",
    ]) ||
    (input.capture !== null &&
      !shape(input.capture, ["transactionRef", "amountCents", "currency"]))
  )
    throw new PaymentEventInboxError("invalid_request");
  // Copy all own data, including nested values, before the first await. Property
  // order is canonical and independent of the caller's insertion order.
  const context = {
    mode: trusted.mode,
    instanceId: trusted.instanceId,
    provider: trusted.provider,
    accountRef: trusted.accountRef,
  };
  const event = {
    eventRef: input.eventRef,
    kind: input.kind,
    providerObjectRef: input.providerObjectRef,
    candidateRequestId: input.candidateRequestId,
    capture:
      input.capture === null
        ? null
        : {
            transactionRef: input.capture.transactionRef,
            amountCents: input.capture.amountCents,
            currency: input.capture.currency,
          },
    occurredAt: input.occurredAt,
  };
  const capture = event.capture;
  if (
    context.mode !== "local-test" ||
    !["stripe", "paypal"].includes(context.provider) ||
    typeof context.instanceId !== "string" ||
    !uuid.test(context.instanceId) ||
    typeof context.accountRef !== "string" ||
    !fixtureRef.test(context.accountRef) ||
    typeof event.eventRef !== "string" ||
    !fixtureRef.test(event.eventRef) ||
    ![
      "unknown",
      "not_found",
      "pending",
      "approved",
      "reported_failed",
      "captured",
      "unmapped",
    ].includes(event.kind) ||
    (event.providerObjectRef !== null &&
      (typeof event.providerObjectRef !== "string" ||
        !fixtureRef.test(event.providerObjectRef))) ||
    (event.candidateRequestId !== null &&
      (typeof event.candidateRequestId !== "string" ||
        !uuid.test(event.candidateRequestId))) ||
    (event.occurredAt !== null && !date(event.occurredAt)) ||
    (event.kind === "captured"
      ? capture === null || event.providerObjectRef === null
      : capture !== null) ||
    (["pending", "approved", "reported_failed"].includes(event.kind) &&
      event.providerObjectRef === null) ||
    (capture !== null &&
      (typeof capture.transactionRef !== "string" ||
        !fixtureRef.test(capture.transactionRef) ||
        !Number.isSafeInteger(capture.amountCents) ||
        capture.amountCents < 1 ||
        typeof capture.currency !== "string" ||
        !/^[A-Z]{3}$/.test(capture.currency))) ||
    !date(now)
  )
    throw new PaymentEventInboxError("invalid_request");
  return { context, event };
}
async function assertScope(db: D1Database, context: TestPaymentEventContext) {
  const scope = await db
    .prepare(
      `SELECT mode,instance_id AS instanceId,stripe_account_ref AS stripeAccountRef,
    paypal_account_ref AS paypalAccountRef FROM commerce_payment_scope WHERE id=1`,
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
    throw new PaymentEventInboxError("unavailable");
}
function previous(
  db: D1Database,
  context: TestPaymentEventContext,
  eventRef: string,
  payloadHash: string,
  receiptId: string,
) {
  // Read BOTH identities together. Never accept an arbitrary first row when an
  // ID and natural key have been made to refer to different stored variants.
  return db
    .prepare(
      `SELECT receipt_id AS receiptId,mode,instance_id AS instanceId,provider,account_ref AS accountRef,
    event_ref AS eventRef,payload_hash AS payloadHash,kind,provider_object_ref AS providerObjectRef,
    candidate_request_id AS candidateRequestId,transaction_ref AS transactionRef,amount_cents AS amountCents,
    currency,occurred_at AS occurredAt,received_at AS receivedAt FROM commerce_payment_event_receipts
    WHERE receipt_id=? OR (mode=? AND instance_id=? AND provider=? AND account_ref=? AND event_ref=? AND payload_hash=?)`,
    )
    .bind(
      receiptId,
      context.mode,
      context.instanceId,
      context.provider,
      context.accountRef,
      eventRef,
      payloadHash,
    )
    .all<Saved>();
}
/** INTERNAL SYNTHETIC LOCAL TEST ONLY. No verification, processing or dispatch.
 * candidateRequestId is an untrusted hint: no attempt/order lookup or authority.
 * This inbox is inert; 0014's CREATE gate does not inspect these receipts. Future
 * verified events need source proof and a pending-event gate bridge first.
 */
export async function recordTestPaymentEvent(
  db: D1Database,
  trusted: TestPaymentEventContext,
  input: TestPaymentEventInput,
  now = Date.now(),
): Promise<TestPaymentEventReceipt> {
  try {
    const { context, event } = normalized(trusted, input, now);
    await assertScope(db, context);
    // Two versioned descriptors. Receipt time is server metadata, never payload
    // identity. Hashes are application witnesses, not provenance or SQL hashing.
    const payloadHash = await commandHash({
      operation: "test-payment-event-payload-v1",
      payload: {
        kind: event.kind,
        providerObjectRef: event.providerObjectRef,
        candidateRequestId: event.candidateRequestId,
        capture: event.capture,
        occurredAt: event.occurredAt,
      },
    });
    const receiptId = await commandHash({
      operation: "test-payment-event-receipt-v1",
      context,
      eventRef: event.eventRef,
      payloadHash,
    });
    const read = async (
      replayed: boolean,
    ): Promise<TestPaymentEventReceipt | null> => {
      const result = await previous(
        db,
        context,
        event.eventRef,
        payloadHash,
        receiptId,
      );
      if (!result.success || !Array.isArray(result.results))
        throw new PaymentEventInboxError("unavailable");
      if (result.results.length === 0) return null;
      const saved = result.results[0];
      if (
        result.results.length !== 1 ||
        saved.receiptId !== receiptId ||
        saved.mode !== context.mode ||
        saved.instanceId !== context.instanceId ||
        saved.provider !== context.provider ||
        saved.accountRef !== context.accountRef ||
        saved.eventRef !== event.eventRef ||
        saved.payloadHash !== payloadHash ||
        saved.kind !== event.kind ||
        saved.providerObjectRef !== event.providerObjectRef ||
        saved.candidateRequestId !== event.candidateRequestId ||
        saved.transactionRef !== (event.capture?.transactionRef ?? null) ||
        saved.amountCents !== (event.capture?.amountCents ?? null) ||
        saved.currency !== (event.capture?.currency ?? null) ||
        saved.occurredAt !== event.occurredAt ||
        !date(saved.receivedAt)
      )
        throw new PaymentEventInboxError("conflict");
      return {
        testOnly: true,
        receiptId,
        eventRef: event.eventRef,
        receivedAt: saved.receivedAt,
        replayed,
      };
    };
    const prior = await read(true);
    if (prior) return prior;
    let confirmedNew = false;
    try {
      const results = await db.batch([
        db
          .prepare(
            `INSERT INTO commerce_payment_event_receipts
        (receipt_id,mode,instance_id,provider,account_ref,event_ref,payload_hash,kind,provider_object_ref,candidate_request_id,transaction_ref,amount_cents,currency,occurred_at,received_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .bind(
            receiptId,
            context.mode,
            context.instanceId,
            context.provider,
            context.accountRef,
            event.eventRef,
            payloadHash,
            event.kind,
            event.providerObjectRef,
            event.candidateRequestId,
            event.capture?.transactionRef ?? null,
            event.capture?.amountCents ?? null,
            event.capture?.currency ?? null,
            event.occurredAt,
            now,
          ),
      ]);
      confirmedNew =
        results.length === 1 &&
        results[0].success === true &&
        results[0].meta?.changes === 1;
    } catch {
      // Response loss and concurrent duplicate recover only this original variant.
      // A missing row cannot prove absence of an external payment.
    }
    const stored = await read(!confirmedNew);
    if (!stored) throw new PaymentEventInboxError("unavailable");
    return stored;
  } catch (error) {
    if (error instanceof PaymentEventInboxError) throw error;
    throw new PaymentEventInboxError("unavailable");
  }
}
