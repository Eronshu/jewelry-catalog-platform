import { Link, useSearchParams } from "react-router";
import { OwnerReturnOperations } from "../../app/components/admin/owner-return-operations";
import type {
  OwnerReturnDetail,
  OwnerReturnReceipt,
} from "../../app/lib/commerce/owner-return";
export function OwnerReturnPreview() {
  const [params] = useSearchParams(),
    scene = params.get("state") ?? "ready",
    inspected = [
      "sellable",
      "unsuitable",
      "restored",
      "waiting_refund",
    ].includes(scene),
    restored = scene === "restored";
  const record: OwnerReturnReceipt = {
    testOnly: true,
    requestId: "22222222-2222-4222-8222-222222222222",
    orderId: "order-11111111-1111-4111-8111-111111111111",
    operation:
      scene === "unsuitable" ? "inspect_unsuitable" : "inspect_sellable",
    recordedAt: 1800000000000,
    expectedVersion: 5,
    expectedStockHash: "a".repeat(64),
    result:
      scene === "unsuitable" ? "unsuitable_received" : "sellable_received",
    replayed: false,
  };
  const detail: OwnerReturnDetail = {
    orderId: record.orderId,
    orderVersion: 5,
    delivery: "shipping",
    fulfillment: scene === "unhanded" ? "not_handed_over" : "handed_over",
    refundState: scene === "waiting_refund" ? "pending" : "succeeded",
    inspection:
      scene === "unsuitable"
        ? "unsuitable"
        : inspected
          ? "sellable"
          : "not_recorded",
    stockState: restored ? "restored" : "not_restored",
    canInspect: !inspected && scene !== "unhanded",
    canRestock: scene === "sellable",
    stockHash: "a".repeat(64),
    lines: [
      {
        position: 0,
        variantId: "fictional-gold-necklace",
        name: "Fictional gold necklace",
        colour: "Gold",
        sku: "FICTIONAL-" + "G".repeat(65),
        quantity: 1,
        onHand: restored || scene === "unhanded" ? 5 : 4,
        facebookReserved: 1,
        checkoutReserved: 0,
        allocated: scene === "unhanded" ? 1 : 0,
      },
    ],
    history: inspected
      ? [
          record,
          ...(restored
            ? [
                {
                  ...record,
                  requestId: "33333333-3333-4333-8333-333333333333",
                  operation: "restock" as const,
                  result: "stock_restored" as const,
                  recordedAt: 1800000001000,
                },
              ]
            : []),
        ]
      : [],
  };
  return (
    <>
      <aside className="admin-panel">
        <strong>Presentation-only return scene.</strong> Fictional memory data,
        paused controls, no Admin authentication, database, provider or stock
        action.
        <nav aria-label="Return preview scenes">
          {[
            "ready",
            "sellable",
            "unsuitable",
            "waiting_refund",
            "restored",
            "unhanded",
          ].map((state) => (
            <p key={state}>
              <Link to={`/owner-return-preview?state=${state}`}>
                {state.replaceAll("_", " ")}
              </Link>
            </p>
          ))}
        </nav>
      </aside>
      <OwnerReturnOperations
        key={scene}
        detail={detail}
        instanceId="55555555-5555-4555-8555-555555555555"
        canWrite={false}
        transport={async () => {
          throw Error("Presentation-only controls are paused");
        }}
      />
    </>
  );
}
