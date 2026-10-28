import {
  registerTestPaymentExecution,
  type TestPaymentExecutionContext,
  type TestPaymentExecutionInput,
} from "./payment-execution-start.server";
import {
  recordTestPaymentObservation,
  type TestPaymentObservationInput,
} from "./payment-observations.server";
import { processTestPaymentObservation } from "./observation-processing.server";
import type {
  TestPaymentSimulator,
  TestPaymentSimulatorCommand,
} from "./payment-simulator.server";

export class PaymentExecutorError extends Error {
  constructor(
    public readonly code:
      "invalid_request" | "not_found" | "conflict" | "unavailable",
  ) {
    super("Local test payment execution could not be confirmed");
    this.name = "PaymentExecutorError";
  }
}
export type TestPaymentExecutorReceipt = {
  testOnly: true;
  claimId: string;
  requestId: string;
  reference: string;
  /** Processing history, never an order payment or fulfillment decision. */
  status: "observation_processed" | "query_required";
  observationId: string | null;
  replayed: boolean;
};
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fixture = /^fixture-[A-Za-z0-9_-]{1,92}$/;
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
    keys.every(
      (key) => "value" in (Object.getOwnPropertyDescriptor(value, key) ?? {}),
    )
  );
}
function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}
function sample(clock: () => number, minimum = 0): number {
  const time = clock();
  if (!integer(time) || time > maxDate || time < minimum)
    throw new PaymentExecutorError("unavailable");
  return time;
}
function result(
  value: unknown,
): Pick<TestPaymentObservationInput, "kind" | "providerObjectRef" | "capture"> {
  const unknown = {
    kind: "unknown" as const,
    providerObjectRef: null,
    capture: null,
  };
  if (!shape(value, ["kind", "providerObjectRef", "capture"])) return unknown;
  const { kind, providerObjectRef, capture } = value;
  if (
    ![
      "unknown",
      "not_found",
      "pending",
      "approved",
      "reported_failed",
      "captured",
    ].includes(kind as string) ||
    (providerObjectRef !== null &&
      (typeof providerObjectRef !== "string" ||
        !fixture.test(providerObjectRef))) ||
    (kind === "captured"
      ? providerObjectRef === null ||
        !shape(capture, ["transactionRef", "amountCents", "currency"])
      : capture !== null) ||
    (["pending", "approved", "reported_failed"].includes(kind as string) &&
      providerObjectRef === null)
  )
    return unknown;
  if (capture !== null) {
    const c = capture as Record<string, unknown>;
    if (
      typeof c.transactionRef !== "string" ||
      !fixture.test(c.transactionRef) ||
      !integer(c.amountCents, 1) ||
      typeof c.currency !== "string" ||
      !/^[A-Z]{3}$/.test(c.currency)
    )
      return unknown;
    return {
      kind: "captured",
      providerObjectRef: providerObjectRef as string,
      capture: {
        transactionRef: c.transactionRef,
        amountCents: c.amountCents,
        currency: c.currency,
      },
    };
  }
  return {
    kind: kind as TestPaymentObservationInput["kind"],
    providerObjectRef: providerObjectRef as string | null,
    capture: null,
  };
}
type SavedObservation = {
  observationId: string;
  attemptId: string;
  claimId: string;
  workerId: string;
  mode: string;
  instanceId: string;
  provider: string;
  accountRef: string;
  kind: TestPaymentObservationInput["kind"];
  providerObjectRef: string | null;
  transactionRef: string | null;
  amountCents: number | null;
  currency: string | null;
  recordedAt: number;
  claimedAt: number;
  requestId: string;
};
type Gate = {
  amountCents: number;
  currency: string;
  createOperationKey: string;
  claimedAt: number;
  leaseUntil: number;
  operation: "create" | "query";
  quoteExpiresAt: number;
  reserveUntil: number;
  state: string;
  paymentState: string;
  fulfillment: string;
  hasEvidence: number;
};
/** No-network internal fixture executor. Registration burns a CREATE opportunity
 * even after crashes. A final read and clock check narrow the dispatch race;
 * they do not solve pauses/state changes between the read and call or establish
 * exactly-once external execution. No route or ordinary runner imports this. */
export async function executeTestPaymentWork(
  db: D1Database,
  trusted: TestPaymentExecutionContext,
  input: TestPaymentExecutionInput,
  simulator: TestPaymentSimulator,
  clock: () => number = Date.now,
): Promise<TestPaymentExecutorReceipt> {
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
    throw new PaymentExecutorError("invalid_request");
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
    !integer(command.expectedVersion, 2) ||
    typeof clock !== "function" ||
    !simulator ||
    typeof simulator.execute !== "function"
  )
    throw new PaymentExecutorError("invalid_request");
  // Snapshot adapter method too; caller mutations while DB work awaits cannot
  // replace the local simulator used by this invocation.
  const execute = simulator.execute.bind(simulator);
  let initial: number;
  try {
    initial = sample(clock);
  } catch {
    throw new PaymentExecutorError("invalid_request");
  }
  try {
    const registered = await registerTestPaymentExecution(
      db,
      context,
      command,
      clock,
    );
    const receipt = (
      status: TestPaymentExecutorReceipt["status"],
      observationId: string | null,
    ): TestPaymentExecutorReceipt => ({
      testOnly: true,
      claimId: command.claimId,
      requestId: command.requestId,
      reference: registered.reference,
      status,
      observationId,
      replayed: registered.replayed,
    });
    // The UUID is reused only in the separate observation identity domain. It
    // never becomes a provider operation key or capture/refund identity.
    const existing = await db
      .prepare(
        `SELECT o.observation_id AS observationId,o.attempt_command_id AS attemptId,
      o.source_claim_id AS claimId,o.source_worker_id AS workerId,o.mode,o.instance_id AS instanceId,
      o.provider,o.account_ref AS accountRef,o.kind,o.provider_object_ref AS providerObjectRef,
      o.transaction_ref AS transactionRef,o.amount_cents AS amountCents,o.currency,o.recorded_at AS recordedAt,
      c.claimed_at AS claimedAt,a.request_id AS requestId
      FROM commerce_payment_observations o LEFT JOIN commerce_payment_work_claims c ON c.claim_id=o.source_claim_id
      LEFT JOIN commerce_payment_attempts a ON a.command_id=o.attempt_command_id WHERE o.observation_id=?`,
      )
      .bind(command.claimId)
      .first<SavedObservation>();
    const process = async (
      observation: TestPaymentObservationInput,
      minimum: number,
    ) => {
      const saved = await recordTestPaymentObservation(
        db,
        context,
        observation,
        sample(clock, Math.max(initial, registered.startedAt, minimum)),
      );
      await processTestPaymentObservation(
        db,
        {
          mode: context.mode,
          instanceId: context.instanceId,
          provider: context.provider,
          accountRef: context.accountRef,
        },
        { observationId: command.claimId },
        sample(clock, Math.max(initial, saved.recordedAt)),
      );
      return receipt("observation_processed", command.claimId);
    };
    if (existing) {
      if (
        existing.observationId !== command.claimId ||
        existing.attemptId !== `payment-start-${command.requestId}` ||
        existing.claimId !== command.claimId ||
        existing.workerId !== context.workerId ||
        existing.mode !== context.mode ||
        existing.instanceId !== context.instanceId ||
        existing.provider !== context.provider ||
        existing.accountRef !== context.accountRef ||
        existing.requestId !== command.requestId ||
        !integer(existing.claimedAt) ||
        !integer(existing.recordedAt) ||
        existing.recordedAt < existing.claimedAt
      )
        throw new PaymentExecutorError("conflict");
      return await process(
        {
          observationId: command.claimId,
          claimId: command.claimId,
          requestId: command.requestId,
          kind: existing.kind,
          providerObjectRef: existing.providerObjectRef,
          capture:
            existing.kind === "captured"
              ? {
                  transactionRef: existing.transactionRef!,
                  amountCents: existing.amountCents!,
                  currency: existing.currency!,
                }
              : null,
        },
        existing.recordedAt,
      );
    }
    if (registered.replayed) return receipt("query_required", null);
    // This final read repeats mutable scope/current-claim and CREATE prerequisites.
    const gate = await db
      .prepare(
        `SELECT a.amount_cents AS amountCents,a.currency,a.create_operation_key AS createOperationKey,
      c.claimed_at AS claimedAt,c.lease_until AS leaseUntil,c.kind AS operation,q.expires_at AS quoteExpiresAt,
      o.reserve_until AS reserveUntil,o.state,o.payment_state AS paymentState,o.fulfillment,
      (EXISTS (SELECT 1 FROM commerce_payment_capture_facts f JOIN commerce_payment_attempts fa ON fa.command_id=f.attempt_command_id WHERE fa.order_id=a.order_id AND f.mode=a.mode AND f.instance_id=a.instance_id)
      OR EXISTS (SELECT 1 FROM commerce_payment_observations b JOIN commerce_payment_attempts ba ON ba.command_id=b.attempt_command_id WHERE ba.order_id=a.order_id AND b.mode=a.mode AND b.instance_id=a.instance_id)) AS hasEvidence
      FROM commerce_payment_execution_starts e JOIN commerce_payment_work_claims c ON c.claim_id=e.claim_id
      JOIN commerce_payment_attempts a ON a.command_id=c.attempt_command_id JOIN commerce_payment_work w ON w.attempt_command_id=a.command_id
      JOIN commerce_orders o ON o.id=a.order_id JOIN commerce_quotes q ON q.id=a.quote_id JOIN commerce_payment_scope s ON s.id=1
      WHERE e.claim_id=?1 AND a.command_id=?2 AND a.request_id=?3 AND a.order_id=?4
      AND e.attempt_command_id=a.command_id AND e.worker_id=?5 AND c.worker_id=?5
      AND e.mode=?6 AND c.mode=?6 AND a.mode=?6 AND s.mode=?6
      AND e.instance_id=?7 AND c.instance_id=?7 AND a.instance_id=?7 AND s.instance_id=?7
      AND e.provider=?8 AND c.provider=?8 AND a.provider=?8
      AND e.account_ref=?9 AND c.account_ref=?9 AND a.account_ref=?9
      AND ?9=CASE ?8 WHEN 'stripe' THEN s.stripe_account_ref ELSE s.paypal_account_ref END
      AND e.expected_work_version=?10 AND w.version=?10 AND c.expected_version+1=?10
      AND w.current_claim_id=c.claim_id AND w.next_operation='query' AND e.operation=c.kind AND e.operation=?11
      AND e.started_at=?12 AND a.occurred_at<=c.claimed_at AND e.started_at>=c.claimed_at AND e.started_at<c.lease_until
      AND (c.kind='query' OR c.expected_version=1)`,
      )
      .bind(
        command.claimId,
        `payment-start-${command.requestId}`,
        command.requestId,
        registered.reference,
        context.workerId,
        context.mode,
        context.instanceId,
        context.provider,
        context.accountRef,
        command.expectedVersion,
        registered.operation,
        registered.startedAt,
      )
      .first<Gate>();
    if (!gate) return receipt("query_required", null);
    if (
      !integer(gate.amountCents, 1) ||
      gate.currency !== "CAD" ||
      typeof gate.createOperationKey !== "string" ||
      !uuid.test(gate.createOperationKey) ||
      !integer(gate.claimedAt) ||
      gate.leaseUntil !== gate.claimedAt + 30_000 ||
      gate.operation !== registered.operation ||
      ![0, 1].includes(gate.hasEvidence)
    )
      throw new PaymentExecutorError("unavailable");
    const adapterCommand: TestPaymentSimulatorCommand = Object.freeze({
      mode: context.mode,
      instanceId: context.instanceId,
      provider: context.provider,
      accountRef: context.accountRef,
      operation: gate.operation,
      amountCents: gate.amountCents,
      currency: "CAD",
      createOperationKey: gate.createOperationKey,
    });
    const dispatchAt = sample(
      clock,
      Math.max(initial, registered.startedAt, gate.claimedAt),
    );
    if (
      dispatchAt >= gate.leaseUntil ||
      (gate.operation === "create" &&
        (gate.state !== "pending_payment" ||
          gate.paymentState !== "processing" ||
          gate.fulfillment !== "none" ||
          !integer(gate.quoteExpiresAt) ||
          !integer(gate.reserveUntil) ||
          gate.quoteExpiresAt <= dispatchAt ||
          gate.reserveUntil <= dispatchAt ||
          gate.hasEvidence !== 0))
    )
      return receipt("query_required", null);
    // No await between the fresh time check and invoking this in-memory adapter.
    let observed: ReturnType<typeof result>;
    try {
      observed = result(await execute(adapterCommand));
    } catch {
      observed = result(null);
    }
    return await process(
      {
        observationId: command.claimId,
        requestId: command.requestId,
        claimId: command.claimId,
        ...observed,
      },
      Math.max(dispatchAt, gate.claimedAt),
    );
  } catch (error) {
    if (error instanceof PaymentExecutorError) throw error;
    // Preserve only known public classifications; never leak adapter/SQL text.
    if (
      error instanceof Error &&
      "code" in error &&
      ["invalid_request", "not_found", "conflict", "unavailable"].includes(
        error.code as string,
      )
    )
      throw new PaymentExecutorError(
        error.code as PaymentExecutorError["code"],
      );
    throw new PaymentExecutorError("unavailable");
  }
}
