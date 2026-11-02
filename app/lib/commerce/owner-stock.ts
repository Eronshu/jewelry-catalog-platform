import type { WorkspaceStock } from "./workspace";

/** Local-test owner commands only; no customer/contact/payment authority. */
export type OwnerStockOperation =
  "receive" | "fb_reserve" | "fb_release" | "fb_sale";
export type OwnerStockSnapshot = {
  variantVersion: number;
  onHand: number;
  facebookReserved: number;
  checkoutReserved: number;
  allocated: number;
};
export type OwnerStockInput = {
  requestId: string;
  variantId: string;
  operation: OwnerStockOperation;
  quantity: number;
  expected: OwnerStockSnapshot;
  acknowledge: true;
};
export type OwnerStockScope = { mode: "local-test"; instanceId: string };
export type OwnerStockDetail = { item: WorkspaceStock; variantVersion: number };
export type OwnerStockReceipt = {
  testOnly: true;
  requestId: string;
  variantId: string;
  operation: OwnerStockOperation;
  quantity: number;
  recordedAt: number;
  replayed: boolean;
  after: OwnerStockSnapshot;
};
