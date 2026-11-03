/** Fictional local notifications and read-only status capabilities. No mail transport. */
export type NotificationScope = { mode: "local-test"; instanceId: string };
export type NotificationStatusScope = NotificationScope & {
  canonicalOrigin: string;
};
export type NotificationConfig = NotificationStatusScope & {
  canonicalOrigin: string;
  linkSecret: string;
};
export type NotificationKind =
  "capture_confirmed" | "refund_confirmed" | "packed" | "handed_over";
export type OwnerNotificationOperation =
  "prepare" | "test_delivered" | "test_failed" | "revoke";
export type OwnerNotificationInput = {
  requestId: string;
  orderId: string;
  operation: OwnerNotificationOperation;
  notificationId: string | null;
};
export type OwnerNotificationReceipt = {
  testOnly: true;
  requestId: string;
  orderId: string;
  operation: OwnerNotificationOperation;
  recorded: true;
};
export type OwnerNotificationDetail = {
  orderId: string;
  canPrepare: boolean;
  notifications: {
    id: string;
    kind: NotificationKind;
    recipient: string;
    subject: string;
    body: string;
    state: "pending" | "test_failed" | "test_delivered" | "revoked";
    statusUrl: string | null;
    expiresAt: number;
    canDeliver: boolean;
    canRevoke: boolean;
    attempts: { outcome: "test_delivered" | "test_failed"; at: number }[];
  }[];
};
export type NotificationStatus = {
  orderId: string;
  state: string;
  paymentState: string;
  fulfillment: string;
  totalCents: number;
  delivery: string;
  refundedCents: number;
};
