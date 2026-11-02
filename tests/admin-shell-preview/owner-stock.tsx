import { OwnerStockOperations } from "../../app/components/admin/owner-stock-operations";
import type {
  OwnerStockDetail,
  OwnerStockReceipt,
  OwnerStockOperation,
} from "../../app/lib/commerce/owner-stock";
const detail: OwnerStockDetail = {
  variantVersion: 1,
  item: {
    variantId: "preview-owner-stock",
    productId: 1,
    productName: "Fictional Orbit Necklace",
    sku: "ORBIT-GOLD",
    colour: "Gold-tone",
    sizeDescription: "Fictional single size",
    priceCents: 2500,
    active: true,
    productStatus: "available",
    onHand: 10,
    facebookReserved: 1,
    checkoutReserved: 2,
    allocated: 3,
    websiteAvailable: 4,
  },
};
// Presentation-only transport. It never fetches a runtime route, authenticates or writes D1.
const receipts = new Map<string, OwnerStockReceipt>();
const transport: typeof fetch = async (_request, init) => {
  const form = new URLSearchParams(String(init?.body)),
    requestId = form.get("requestId")!;
  if (receipts.has(requestId))
    return Response.json({
      state: "recorded",
      receipt: receipts.get(requestId),
    });
  if (form.get("intent") === "lookup")
    return Response.json({ state: "not_recorded" });
  const operation = form.get("operation") as OwnerStockOperation,
    quantity = Number(form.get("quantity"));
  const before = {
    variantVersion: Number(form.get("variantVersion")),
    onHand: Number(form.get("onHand")),
    facebookReserved: Number(form.get("facebookReserved")),
    checkoutReserved: Number(form.get("checkoutReserved")),
    allocated: Number(form.get("allocated")),
  };
  const receipt: OwnerStockReceipt = {
    testOnly: true,
    requestId,
    variantId: detail.item.variantId,
    operation,
    quantity,
    recordedAt: Date.now(),
    replayed: false,
    after: {
      ...before,
      onHand:
        before.onHand +
        (operation === "receive" ? quantity : operation === "fb_sale" ? -1 : 0),
      facebookReserved:
        before.facebookReserved +
        (operation === "fb_reserve" ? 1 : operation === "receive" ? 0 : -1),
    },
  };
  receipts.set(requestId, receipt);
  return Response.json({ state: "recorded", receipt });
};
export function OwnerStockPreview() {
  return (
    <>
      <aside className="admin-panel">
        <strong>Presentation-only stock scene.</strong> In-memory fictional
        responses; no Admin authentication, database or actual stock. Reload
        resets the displayed quantities. Saved browser requests still need
        checking.
      </aside>
      <OwnerStockOperations
        detail={detail}
        instanceId="33333333-3333-4333-8333-333333333333"
        canWrite
        transport={transport}
      />
    </>
  );
}
