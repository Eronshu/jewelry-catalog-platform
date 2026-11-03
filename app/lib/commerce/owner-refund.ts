/** Fictional refund commands; inventory/returns remain separate owner actions. */
export type OwnerRefundScope = { mode: "local-test"; instanceId: string };
export type OwnerRefundInput = {
  requestId: string;
  orderId: string;
  expectedVersion: number;
  acknowledge: true;
  refundCents?: number;
  expectedRefundedCents?: number;
};
export type OwnerRefundState =
  | "not_started"
  | "prepared"
  | "pending"
  | "succeeded"
  | "partially_refunded"
  | "review_required";
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
  remainingCents?: number;
  fullyRefunded?: boolean;
  history?: OwnerRefundReceipt[];
  canStartPartial?: boolean;
  currentRequestRefundCents?: number | null;
  currentRequestPriorRefundedCents?: number | null;
};
export type OwnerRefundReceipt = {
  refundCents?: number;
  expectedRefundedCents?: number;
  testOnly: true;
  requestId: string;
  orderId: string;
  state: OwnerRefundState;
  amountCents: number;
  refundedCents: number;
};
