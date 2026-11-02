/** Owner-recorded fictional full-order operations; no carrier/payment authority. */
export type OwnerFulfillmentScope = { mode: "local-test"; instanceId: string };
export type OwnerFulfillmentOperation = "pack" | "collect" | "deliver" | "ship";
export type OwnerFulfillmentInput = {
  requestId: string;
  orderId: string;
  operation: OwnerFulfillmentOperation;
  expectedVersion: number;
  acknowledge: true;
};
export type OwnerFulfillmentReceipt = {
  testOnly: true;
  requestId: string;
  orderId: string;
  operation: OwnerFulfillmentOperation;
  recordedAt: number;
  replayed: boolean;
  resultingVersion: number;
};
export type OwnerFulfillmentDetail = {
  orderId: string;
  version: number;
  delivery: string;
  state: "blocked" | "ready_to_pack" | "packed" | "handed_over";
  canPack: boolean;
  canHandoff: boolean;
  history: OwnerFulfillmentReceipt[];
};
