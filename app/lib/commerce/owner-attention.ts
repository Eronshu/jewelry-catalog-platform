/** Read-only review of fictional local commerce records. No command authority. */
export type AttentionScope = {
  mode: "local-test";
  instanceId: string;
  canonicalOrigin: string;
};
export type AttentionFilter = "all" | "payment" | "refund" | "notifications";
export type AttentionQuery = {
  filter: AttentionFilter;
  /** Empty, or one complete order reference. */
  reference: string;
  after: string | null;
};
export type AttentionItem = {
  orderId: string;
  createdAt: number;
  totalCents: number;
  paymentState: string;
  fulfillment: string;
  paymentReview: boolean;
  refundReview: boolean;
  notificationPending: number;
  notificationFailed: number;
  notificationMissing: number;
  notificationExhausted: number;
};
export type AttentionView = {
  observedAt: number;
  filter: AttentionFilter;
  reference: string;
  nextCursor: string | null;
  summary: {
    orderCount: number;
    paymentCount: number;
    refundCount: number;
    notificationCount: number;
  };
  items: AttentionItem[];
};
