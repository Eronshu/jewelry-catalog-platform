import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { CommerceWorkspace } from "../../app/components/admin/commerce-workspace";
import type {
  WorkspaceOrder,
  WorkspaceStock,
  WorkspaceView,
} from "../../app/lib/commerce/workspace";

// Presentation-only synthetic data. This module is never a Worker, DB or Access identity.
const observedAt = Date.UTC(2026, 9, 30, 18, 30);
export const workspaceOrder: WorkspaceOrder = {
  reference: "order-11111111-1111-4111-8111-111111111111",
  createdAt: observedAt - 240000,
  reserveUntil: observedAt + 360000,
  orderState: "pending_payment",
  paymentState: "processing",
  fulfillmentState: "none",
  hasPaymentAttempt: true,
  itemCount: 3,
  delivery: "shipping",
  subtotalCents: 7500,
  shippingCents: 1500,
  taxCents: 900,
  totalCents: 9900,
};
export const workspaceStocks: WorkspaceStock[] = [
  {
    variantId: "fictional-necklace-gold",
    productId: 1,
    productName: "Fictional Orbit Necklace",
    sku: "ORBIT-GOLD",
    colour: "Gold-tone",
    sizeDescription: "Universal size",
    priceCents: 2500,
    active: true,
    productStatus: "available",
    onHand: 12,
    facebookReserved: 1,
    checkoutReserved: 3,
    allocated: 2,
    websiteAvailable: 6,
  },
  {
    variantId: "fictional-necklace-silver",
    productId: 1,
    productName: "Fictional Orbit Necklace",
    sku: "ORBIT-SILVER",
    colour: "Silver-tone",
    sizeDescription: "Universal size",
    priceCents: 2500,
    active: true,
    productStatus: "draft",
    onHand: 5,
    facebookReserved: 1,
    checkoutReserved: 0,
    allocated: 0,
    websiteAvailable: 0,
  },
  {
    variantId: "fictional-necklace-black",
    productId: 1,
    productName: "Fictional Orbit Necklace",
    sku: "ORBIT-BLACK",
    colour: "Black",
    sizeDescription: "Universal size",
    priceCents: 2500,
    active: false,
    productStatus: "available",
    onHand: 2,
    facebookReserved: 0,
    checkoutReserved: 0,
    allocated: 0,
    websiteAvailable: 0,
  },
];
export function workspaceFixtureLoader({
  request,
  params,
}: Pick<LoaderFunctionArgs, "request" | "params">): WorkspaceView {
  const url = new URL(request.url),
    empty =
      url.searchParams.get("scene") === "empty" ||
      url.searchParams.has("after");
  if (params.orderId)
    return {
      kind: "order",
      observedAt,
      order: { ...workspaceOrder, reference: params.orderId },
      lines: [
        {
          name: "Fictional Orbit Necklace",
          sku: "ORBIT-GOLD",
          colour: "Gold-tone",
          sizeDescription: "Universal size",
          quantity: 2,
          unitPriceCents: 2500,
          lineTotalCents: 5000,
        },
        {
          name: "Fictional Orbit Necklace",
          sku: "ORBIT-SILVER",
          colour: "Silver-tone",
          sizeDescription: "Universal size",
          quantity: 1,
          unitPriceCents: 2500,
          lineTotalCents: 2500,
        },
      ],
    };
  if (url.pathname.endsWith("/inventory")) {
    const status = url.searchParams.get("status"),
      filter =
        status === "available" || status === "unavailable" ? status : "all";
    const search = url.searchParams.get("search") ?? "";
    const items = workspaceStocks.filter(
      (item) =>
        (filter === "all" ||
          (filter === "available") === item.websiteAvailable > 0) &&
        `${item.sku} ${item.productName} ${item.colour}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    );
    return {
      kind: "inventory",
      observedAt,
      items: empty ? [] : items,
      filter,
      search,
      nextCursor: empty ? null : "presentation-next-stock-page",
    };
  }
  if (url.pathname.endsWith("/orders")) {
    const status = url.searchParams.get("status"),
      filter =
        status === "awaiting" || status === "prepared" || status === "cancelled"
          ? status
          : "all";
    const reference = url.searchParams.get("reference") ?? "";
    const sample =
      filter === "cancelled"
        ? {
            ...workspaceOrder,
            orderState: "cancelled",
            paymentState: "not_started",
            hasPaymentAttempt: false,
          }
        : filter === "awaiting"
          ? {
              ...workspaceOrder,
              paymentState: "not_started",
              hasPaymentAttempt: false,
            }
          : workspaceOrder;
    return {
      kind: "orders",
      observedAt,
      items:
        empty || (reference && reference !== sample.reference) ? [] : [sample],
      filter,
      reference,
      nextCursor: empty ? null : "presentation-next-order-page",
    };
  }
  return {
    kind: "overview",
    observedAt,
    summary: empty
      ? {
          pendingCount: 0,
          preparedCount: 0,
          cancelledCount: 0,
          variantCount: 0,
          availableUnits: 0,
          facebookUnits: 0,
          reservedUnits: 0,
          allocatedUnits: 0,
        }
      : {
          pendingCount: 2,
          preparedCount: 1,
          cancelledCount: 1,
          variantCount: 3,
          availableUnits: 6,
          facebookUnits: 2,
          reservedUnits: 3,
          allocatedUnits: 2,
        },
    recentOrders: empty ? [] : [workspaceOrder],
  };
}
function PreviewWorkspace() {
  const view = useLoaderData<WorkspaceView>();
  return (
    <>
      <aside
        className="commerce-workspace-preview"
        aria-label="Presentation fixture notice"
      >
        <strong>Presentation only — fictional fixtures</strong>
        <p>
          No database, Admin authentication or business action is connected.
          These scenes only preview the workspace.
        </p>
        <nav aria-label="Workspace preview scenes">
          <Link to="/admin/commerce">Overview</Link>
          <Link to="/admin/commerce/orders">Orders</Link>
          <Link to={`/admin/commerce/orders/${workspaceOrder.reference}`}>
            Order detail
          </Link>
          <Link to="/admin/commerce/inventory">Inventory</Link>
          <Link to="/admin/commerce?scene=empty">Empty overview</Link>
          <Link to="/admin/commerce/orders?scene=empty">Empty orders</Link>
          <Link to="/admin/commerce/inventory?scene=empty">
            Empty inventory
          </Link>
        </nav>
      </aside>
      <CommerceWorkspace view={view} />
    </>
  );
}
export const commerceWorkspacePreviewRoutes = [
  "/admin/commerce",
  "/admin/commerce/orders",
  "/admin/commerce/orders/:orderId",
  "/admin/commerce/inventory",
].map((path) => ({
  path,
  loader: workspaceFixtureLoader,
  Component: PreviewWorkspace,
}));
