import { OwnerNotifications } from "../../app/components/admin/owner-notifications";
export function OwnerNotificationsPreview() {
  return (
    <>
      <aside className="admin-panel">
        <strong>Presentation only.</strong> Fictional inbox, paused operations,
        no authentication, database, delivery or working status link.
      </aside>
      <OwnerNotifications
        instanceId="55555555-5555-4555-8555-555555555555"
        canWrite={false}
        detail={{
          orderId: "order-11111111-1111-4111-8111-111111111111",
          canPrepare: true,
          notifications: [
            {
              id: "22222222-2222-4222-8222-222222222222",
              kind: "capture_confirmed",
              recipient: "ontario@example.invalid",
              subject: "[FICTIONAL TEST] Payment confirmed",
              body: "Fictional local test only. Payment confirmed for this order. No email was sent. The private status link expires after 24 hours.",
              state: "test_delivered",
              statusUrl: null,
              expiresAt: 1800086400000,
              canDeliver: false,
              canRevoke: true,
              attempts: [
                { outcome: "test_failed", at: 1800000000000 },
                { outcome: "test_delivered", at: 1800000100000 },
              ],
            },
            {
              id: "33333333-3333-4333-8333-333333333333",
              kind: "refund_confirmed",
              recipient: "ontario@example.invalid",
              subject: "[FICTIONAL TEST] Refund verified",
              body: "Fictional local test only. A refund was verified. Check current status for the cumulative verified amount. No email was sent.",
              state: "pending",
              statusUrl: null,
              expiresAt: 1800086400000,
              canDeliver: true,
              canRevoke: true,
              attempts: [],
            },
          ],
        }}
      />
    </>
  );
}
