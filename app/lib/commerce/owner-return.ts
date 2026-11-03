import type { OwnerRefundState } from "./owner-refund";
/** Fictional whole-order physical inspection and independently authorized restock. */
export type OwnerReturnScope = { mode: "local-test"; instanceId: string };
export type OwnerReturnOperation =
  "inspect_sellable" | "inspect_unsuitable" | "restock";
export type OwnerReturnInput = {
  requestId: string;
  orderId: string;
  operation: OwnerReturnOperation;
  expectedVersion: number;
  expectedStockHash: string;
  acknowledge: true;
};
export type OwnerReturnReceipt = {
  testOnly: true;
  requestId: string;
  orderId: string;
  operation: OwnerReturnOperation;
  recordedAt: number;
  expectedVersion: number;
  expectedStockHash: string;
  result: "sellable_received" | "unsuitable_received" | "stock_restored";
  replayed: boolean;
};
export type OwnerReturnLine = {
  position: number;
  variantId: string;
  name: string;
  sku: string;
  colour: string;
  quantity: number;
  onHand: number;
  facebookReserved: number;
  checkoutReserved: number;
  allocated: number;
};
export type OwnerReturnDetail = {
  orderId: string;
  orderVersion: number;
  delivery: string;
  fulfillment: "not_handed_over" | "handed_over";
  refundState: OwnerRefundState;
  inspection: "not_recorded" | "sellable" | "unsuitable";
  stockState: "not_restored" | "restored";
  canInspect: boolean;
  canRestock: boolean;
  stockHash: string;
  lines: OwnerReturnLine[];
  history: OwnerReturnReceipt[];
};
