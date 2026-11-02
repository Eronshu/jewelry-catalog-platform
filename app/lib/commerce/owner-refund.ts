/** One full fictional test refund; inventory/return policy is outside this slice. */
export type OwnerRefundScope = { mode: "local-test"; instanceId: string };
export type OwnerRefundInput = {
  requestId: string;
  orderId: string;
  expectedVersion: number;
  acknowledge: true;
};
export type OwnerRefundState =
  "not_started" | "prepared" | "pending" | "succeeded" | "review_required";
export type OwnerRefundDetail = {
  orderId: string;
  orderVersion: number;
  amountCents: number;
  refundedCents: number;
  provider: "stripe" | "paypal" | null;
  state: OwnerRefundState;
  requestId: string | null;
  requestVersion: number | null;
  canStart: boolean;
  canQuery: boolean;
};
export type OwnerRefundReceipt = {
  testOnly: true;
  requestId: string;
  orderId: string;
  state: OwnerRefundState;
  amountCents: number;
  refundedCents: number;
};
