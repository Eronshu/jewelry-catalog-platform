/** Owner-facing read projections; never include raw snapshots or customer/session secrets. */
export type WorkspaceOrder = {
  reference: string;
  createdAt: number;
  reserveUntil: number;
  orderState: string;
  paymentState: string;
  fulfillmentState: string;
  hasPaymentAttempt: boolean;
  itemCount: number;
  delivery: string;
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
};
export type WorkspaceLine = {
  name: string;
  sku: string;
  colour: string;
  sizeDescription: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
};
export type WorkspaceStock = {
  variantId: string;
  productId: number;
  productName: string;
  sku: string;
  colour: string;
  sizeDescription: string;
  priceCents: number;
  active: boolean;
  productStatus: string;
  onHand: number;
  facebookReserved: number;
  checkoutReserved: number;
  allocated: number;
  websiteAvailable: number;
};
export type WorkspaceSummary = {
  pendingCount: number;
  preparedCount: number;
  cancelledCount: number;
  variantCount: number;
  availableUnits: number;
  facebookUnits: number;
  reservedUnits: number;
  allocatedUnits: number;
};
export type WorkspaceOrderFilter =
  "all" | "awaiting" | "prepared" | "cancelled";
export type WorkspaceStockFilter = "all" | "available" | "unavailable";
export type WorkspaceView = (
  | {
      kind: "overview";
      summary: WorkspaceSummary;
      recentOrders: WorkspaceOrder[];
    }
  | {
      kind: "orders";
      items: WorkspaceOrder[];
      filter: WorkspaceOrderFilter;
      reference: string;
      nextCursor: string | null;
    }
  | { kind: "order"; order: WorkspaceOrder; lines: WorkspaceLine[] }
  | {
      kind: "inventory";
      items: WorkspaceStock[];
      filter: WorkspaceStockFilter;
      search: string;
      nextCursor: string | null;
    }
) & { observedAt: number };
