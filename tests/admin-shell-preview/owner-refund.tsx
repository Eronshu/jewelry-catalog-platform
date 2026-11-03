import { OwnerRefundOperations } from "../../app/components/admin/owner-refund-operations";
import type { OwnerRefundDetail } from "../../app/lib/commerce/owner-refund";
export function OwnerRefundPreview() {
  const params = new URLSearchParams(window.location.search);
  const state = params.get("state");
  const pending = state === "pending",
    succeeded = state === "succeeded",
    partial = state === "partial",
    stripe = params.get("provider") !== "paypal";
  const detail: OwnerRefundDetail = {
    orderId: "order-11111111-1111-4111-8111-111111111111",
    orderVersion: 3,
    requestVersion: pending || succeeded ? 3 : null,
    amountCents: 4400,
    refundedCents: succeeded ? 4400 : partial ? 1500 : 0,
    remainingCents: succeeded ? 0 : partial ? 2900 : 4400,
    canStartPartial: stripe && !pending && !succeeded,
    provider: stripe ? "stripe" : "paypal",
    state: succeeded
      ? "succeeded"
      : pending
        ? "pending"
        : partial
          ? "partially_refunded"
          : "not_started",
    requestId:
      pending || succeeded ? "22222222-2222-4222-8222-222222222222" : null,
    canStart: !pending && !succeeded && !partial,
    history: partial
      ? [
          {
            testOnly: true,
            requestId: "22222222-2222-4222-8222-222222222222",
            orderId: "order-11111111-1111-4111-8111-111111111111",
            amountCents: 4400,
            refundCents: 1500,
            expectedRefundedCents: 0,
            refundedCents: 1500,
            state: "succeeded",
          },
        ]
      : [],
    canQuery: pending,
  };
  return (
    <>
      <aside className="admin-panel">
        <strong>Presentation-only refund scene.</strong> Fictional data, paused
        controls, no Admin authentication, database or provider request.
      </aside>
      <OwnerRefundOperations
        detail={detail}
        instanceId="55555555-5555-4555-8555-555555555555"
        canWrite={false}
        canQuery={false}
        transport={async () => {
          throw Error("Presentation only");
        }}
      />
    </>
  );
}
