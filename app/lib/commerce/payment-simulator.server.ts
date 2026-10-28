/** Fictional in-memory test state. This is not a real provider adapter or a
 * durability claim. Keep the same simulator across executor restarts to query
 * its history; resetting it loses that history. Query-by-create-key is a test
 * capability and says nothing about Stripe or PayPal's actual lookup APIs. */
export type TestPaymentSimulatorCommand = Readonly<{
  mode: "local-test";
  instanceId: string;
  provider: "stripe" | "paypal";
  accountRef: string;
  operation: "create" | "query";
  createOperationKey: string;
  amountCents: number;
  currency: "CAD";
}>;
export type TestPaymentSimulatorKind =
  | "unknown"
  | "not_found"
  | "pending"
  | "approved"
  | "reported_failed"
  | "captured";
export type TestPaymentSimulatorResult = {
  kind: TestPaymentSimulatorKind;
  providerObjectRef: string | null;
  capture: {
    transactionRef: string;
    amountCents: number;
    currency: "CAD";
  } | null;
};
export type TestPaymentSimulator = {
  execute(command: TestPaymentSimulatorCommand): Promise<unknown>;
};
export type TestPaymentSimulatorStep = {
  kind: TestPaymentSimulatorKind;
  /** Model a committed fictional capture whose response never reaches a worker. */
  throwAfterCommit?: true;
};
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fixture = /^fixture-[A-Za-z0-9_-]{1,92}$/;
const kinds = [
  "unknown",
  "not_found",
  "pending",
  "approved",
  "reported_failed",
  "captured",
];
function copy(result: TestPaymentSimulatorResult): TestPaymentSimulatorResult {
  return { ...result, capture: result.capture && { ...result.capture } };
}
export function createTestPaymentSimulator(
  script: readonly TestPaymentSimulatorStep[] = [{ kind: "captured" }],
): TestPaymentSimulator {
  const steps = script.map((step) => {
    if (
      !kinds.includes(step.kind) ||
      (step.throwAfterCommit !== undefined &&
        (step.throwAfterCommit !== true || step.kind !== "captured"))
    )
      throw new Error("Invalid fictional payment script");
    return { ...step };
  });
  const history = new Map<
    string,
    { amount: number; result: TestPaymentSimulatorResult }
  >();
  let sequence = 0;
  return {
    async execute(command) {
      const c = { ...command };
      if (
        c.mode !== "local-test" ||
        !uuid.test(c.instanceId) ||
        !["stripe", "paypal"].includes(c.provider) ||
        !fixture.test(c.accountRef) ||
        !["create", "query"].includes(c.operation) ||
        !uuid.test(c.createOperationKey) ||
        !Number.isSafeInteger(c.amountCents) ||
        c.amountCents < 1 ||
        c.currency !== "CAD"
      )
        throw new Error("Invalid fictional payment command");
      const key = JSON.stringify([
        c.mode,
        c.instanceId,
        c.provider,
        c.accountRef,
        c.createOperationKey,
      ]);
      const existing = history.get(key);
      if (existing && existing.amount !== c.amountCents)
        throw new Error("Conflicting fictional payment parameters");
      if (existing) return copy(existing.result);
      if (c.operation === "query")
        return { kind: "not_found", providerObjectRef: null, capture: null };
      const step = steps[Math.min(sequence, steps.length - 1)] ?? {
        kind: "unknown",
      };
      ++sequence;
      const result: TestPaymentSimulatorResult = {
        kind: step.kind,
        providerObjectRef: ["unknown", "not_found"].includes(step.kind)
          ? null
          : `fixture-object-${c.createOperationKey}`,
        capture:
          step.kind === "captured"
            ? {
                transactionRef: `fixture-capture-${c.createOperationKey}`,
                amountCents: c.amountCents,
                currency: c.currency,
              }
            : null,
      };
      history.set(key, { amount: c.amountCents, result });
      if (step.throwAfterCommit)
        throw new Error("Fictional payment response unavailable");
      return copy(result);
    },
  };
}
