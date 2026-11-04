import { OwnerAttention } from "../../app/components/admin/owner-attention";
export function OwnerAttentionPreview() {
  return (
    <>
      <aside className="admin-panel">
        <strong>Presentation only.</strong> Fictional attention records; no
        Admin authentication, database, provider, refund or email action.
      </aside>
      <OwnerAttention
        canOpenRefunds={false}
        canOpenNotifications={false}
        view={{
          observedAt: 1800000000000,
          filter: "all",
          reference: "",
          nextCursor: null,
          summary: {
            orderCount: 2,
            paymentCount: 1,
            refundCount: 1,
            notificationCount: 1,
          },
          items: [
            {
              orderId: "order-11111111-1111-4111-8111-111111111111",
              createdAt: 1799999900000,
              totalCents: 4400,
              paymentState: "processing",
              fulfillment: "none",
              paymentReview: true,
              refundReview: false,
              notificationPending: 0,
              notificationFailed: 0,
              notificationMissing: 0,
              notificationExhausted: 0,
            },
            {
              orderId: "order-22222222-2222-4222-8222-222222222222",
              createdAt: 1799999800000,
              totalCents: 9900,
              paymentState: "succeeded",
              fulfillment: "ready_to_pack",
              paymentReview: false,
              refundReview: true,
              notificationPending: 0,
              notificationFailed: 1,
              notificationMissing: 2,
              notificationExhausted: 1,
            },
          ],
        }}
      />
    </>
  );
}
