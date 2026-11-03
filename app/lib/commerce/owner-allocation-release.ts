import type { OwnerRefundState } from "./owner-refund";
import type { OwnerReturnLine } from "./owner-return";
/** Explicit fictional confirmation that the whole unhanded order remains sellable. */
export type OwnerAllocationReleaseScope = {
  mode: "local-test";
  instanceId: string;
};
export type OwnerAllocationReleaseInput = {
  requestId: string;
  orderId: string;
  expectedVersion: number;
  expectedStockHash: string;
  acknowledge: true;
};
export type OwnerAllocationReleaseReceipt = {
  testOnly: true;
  requestId: string;
  orderId: string;
  recordedAt: number;
  expectedVersion: number;
  expectedStockHash: string;
  result: "allocation_released";
  replayed: boolean;
};
export type OwnerAllocationReleaseDetail = {
  orderId: string;
  orderVersion: number;
  fulfillment: "not_handed_over" | "handed_over";
  refundState: OwnerRefundState;
  released: boolean;
  canRelease: boolean;
  stockHash: string;
  lines: OwnerReturnLine[];
  history: OwnerAllocationReleaseReceipt[];
};
