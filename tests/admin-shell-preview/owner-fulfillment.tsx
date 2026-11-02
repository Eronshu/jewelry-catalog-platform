import { OwnerFulfillmentOperations } from "../../app/components/admin/owner-fulfillment-operations";
import type { OwnerFulfillmentDetail } from "../../app/lib/commerce/owner-fulfillment";
export function OwnerFulfillmentPreview() {
  const params = new URLSearchParams(window.location.search);
  const delivery = ["pickup", "local_delivery", "shipping"].includes(
    params.get("delivery")!,
  )
    ? params.get("delivery")!
    : "shipping";
  const state =
    params.get("state") === "packed"
      ? "packed"
      : params.get("state") === "blocked"
        ? "blocked"
        : params.get("state") === "handed_over"
          ? "handed_over"
          : "ready_to_pack";
  const orderId = "order-11111111-1111-4111-8111-111111111111";
  const detail: OwnerFulfillmentDetail = {
    orderId,
    version: state === "ready_to_pack" ? 3 : state === "handed_over" ? 5 : 4,
    delivery,
    state,
    canPack: state === "ready_to_pack",
    canHandoff: state === "packed",
    history:
      state === "packed" || state === "handed_over"
        ? [
            {
              testOnly: true,
              requestId: "22222222-2222-4222-8222-222222222222",
              orderId,
              operation: "pack",
              resultingVersion: 4,
              recordedAt: 1793630000000,
              replayed: true,
            },
          ]
        : [],
  };
  return (
    <>
      <aside className="admin-panel">
        <strong>Presentation-only fulfillment scene.</strong> No Admin
        authentication, database, actual stock or external request. Actions are
        paused; this previews layout only.
      </aside>
      <OwnerFulfillmentOperations
        detail={detail}
        instanceId="44444444-4444-4444-8444-444444444444"
        canWrite={false}
        transport={async () => {
          throw Error("Presentation only");
        }}
      />
    </>
  );
}
