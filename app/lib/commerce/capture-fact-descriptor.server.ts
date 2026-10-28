import { commandHash } from "./inventory.server";

/** Shared v1 economic identity. Property order is part of the durable contract. */
export async function captureFactDescriptor(
  context: {
    mode: "local-test";
    instanceId: string;
    provider: "stripe" | "paypal";
    accountRef: string;
  },
  fact: {
    attemptCommandId: string;
    reference: string;
    providerObjectRef: string;
    transactionRef: string;
    amountCents: number;
    currency: string;
    expectedAmountCents: number;
    expectedCurrency: string;
  },
) {
  // Snapshot all payload values before hashing can yield.
  const captured = { ...fact };
  const identity = {
    operation: "test-capture-identity-v1",
    mode: context.mode,
    instanceId: context.instanceId,
    provider: context.provider,
    accountRef: context.accountRef,
    transactionRef: captured.transactionRef,
  };
  const payload = {
    operation: "test-capture-payload-v1",
    identity,
    attemptCommandId: captured.attemptCommandId,
    reference: captured.reference,
    providerObjectRef: captured.providerObjectRef,
    amountCents: captured.amountCents,
    currency: captured.currency,
    expectedAmountCents: captured.expectedAmountCents,
    expectedCurrency: captured.expectedCurrency,
  };
  const amountMatch =
    captured.amountCents === captured.expectedAmountCents &&
    captured.currency === captured.expectedCurrency
      ? ("match" as const)
      : ("mismatch" as const);
  return {
    id: await commandHash(identity),
    payloadHash: await commandHash(payload),
    amountMatch,
  };
}
