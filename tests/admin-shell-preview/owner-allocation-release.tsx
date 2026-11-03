import { Link, useSearchParams } from "react-router";
import { OwnerAllocationReleaseOperations } from "../../app/components/admin/owner-allocation-release-operations";
import type { OwnerAllocationReleaseDetail } from "../../app/lib/commerce/owner-allocation-release";
export function OwnerAllocationReleasePreview() {
  const [params] = useSearchParams(),
    state = params.get("state") ?? "ready",
    released = state === "released";
  const detail: OwnerAllocationReleaseDetail = {
    orderId: "order-11111111-1111-4111-8111-111111111111",
    orderVersion: 3,
    fulfillment: state === "handed_over" ? "handed_over" : "not_handed_over",
    refundState: state === "pending_refund" ? "pending" : "succeeded",
    released,
    canRelease: state === "ready",
    stockHash: "a".repeat(64),
    lines: [
      {
        position: 0,
        variantId: "fictional-gold-necklace",
        name: "Fictional gold necklace",
        colour: "Gold",
        sku: "FICTIONAL-" + "G".repeat(65),
        quantity: 1,
        onHand: state === "handed_over" ? 4 : 5,
        facebookReserved: 1,
        checkoutReserved: 0,
        allocated: released || state === "handed_over" ? 0 : 1,
      },
    ],
    history: released
      ? [
          {
            testOnly: true,
            requestId: "22222222-2222-4222-8222-222222222222",
            orderId: "order-11111111-1111-4111-8111-111111111111",
            recordedAt: 1793680000000,
            expectedVersion: 3,
            expectedStockHash: "b".repeat(64),
            result: "allocation_released",
            replayed: false,
          },
        ]
      : [],
  };
  return (
    <>
      <aside className="admin-panel">
        <strong>Presentation-only stock release.</strong> Fictional props,
        paused controls. No Admin authentication, database, provider or stock
        writes.
        <nav aria-label="Stock release preview scenes">
          {["ready", "pending_refund", "handed_over", "released"].map((s) => (
            <p key={s}>
              <Link to={`/owner-allocation-release-preview?state=${s}`}>
                {s.replaceAll("_", " ")}
              </Link>
            </p>
          ))}
        </nav>
      </aside>
      <OwnerAllocationReleaseOperations
        key={state}
        detail={detail}
        instanceId="11111111-1111-4111-8111-111111111111"
        canWrite={false}
        transport={async () => {
          throw Error("Presentation actions are paused");
        }}
      />
    </>
  );
}
