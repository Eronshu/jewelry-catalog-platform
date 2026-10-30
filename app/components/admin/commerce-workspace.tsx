import { Form, Link, NavLink, useNavigation } from "react-router";
import type {
  WorkspaceOrder,
  WorkspaceStock,
  WorkspaceView,
} from "../../lib/commerce/workspace";
import { formatCad } from "../../lib/format-cad";
import { AdminShell } from "./admin-shell";

const base = "/admin/commerce";
const deliveryNames: Record<string, string> = {
  pickup: "Pickup",
  local_delivery: "Local delivery",
  shipping: "Canadian shipping",
};
const orderNames: Record<string, string> = {
  pending_payment: "Unpaid order",
  cancelled: "Cancelled",
  confirmed: "Confirmed in test records",
  closed: "Closed in test records",
};
const paymentNames: Record<string, string> = {
  not_started: "Not started",
  processing: "Payment preparation recorded",
  unknown: "Unknown — needs review",
  succeeded: "Success recorded — needs reconciliation",
  failed: "Failure recorded — needs review",
};
const fulfillmentNames: Record<string, string> = {
  none: "Not started",
  held: "On hold",
  ready_to_pack: "Ready to pack in test records",
  completed: "Completed in test records",
};
const stateLabel = (labels: Record<string, string>, value: string) =>
  labels[value] ?? "Unrecognized status — needs review";
function Time({ value }: { value: number }) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? (
    <time dateTime={date.toISOString()}>
      {new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Toronto",
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date)}{" "}
      (Toronto)
    </time>
  ) : (
    <>Time unavailable</>
  );
}
function Facts({ order }: { order: WorkspaceOrder }) {
  return (
    <dl className="commerce-workspace-facts">
      <div>
        <dt>Order</dt>
        <dd>{stateLabel(orderNames, order.orderState)}</dd>
      </div>
      <div>
        <dt>Payment</dt>
        <dd>{stateLabel(paymentNames, order.paymentState)}</dd>
      </div>
      <div>
        <dt>Fulfillment</dt>
        <dd>{stateLabel(fulfillmentNames, order.fulfillmentState)}</dd>
      </div>
      <div>
        <dt>Delivery</dt>
        <dd>{stateLabel(deliveryNames, order.delivery)}</dd>
      </div>
    </dl>
  );
}
function PaymentNotice({ order }: { order: WorkspaceOrder }) {
  if (!order.hasPaymentAttempt) return null;
  return (
    <p className="commerce-workspace-notice">
      A payment attempt is recorded. This is not proof of payment. Ordinary
      cancellation or expiry cannot release this stock; payment review is
      required.
    </p>
  );
}
function OrderCard({ order }: { order: WorkspaceOrder }) {
  return (
    <article className="commerce-workspace-card">
      <div className="commerce-workspace-card-heading">
        <h3>
          <Link to={`${base}/orders/${encodeURIComponent(order.reference)}`}>
            {order.reference}
          </Link>
        </h3>
        <strong>{formatCad(order.totalCents)} CAD</strong>
      </div>
      <p className="commerce-workspace-muted">
        {order.itemCount} {order.itemCount === 1 ? "item" : "items"} · Created{" "}
        <Time value={order.createdAt} />
      </p>
      <Facts order={order} />
      <PaymentNotice order={order} />
    </article>
  );
}
function OrderList({ items }: { items: WorkspaceOrder[] }) {
  return items.length ? (
    <div className="commerce-workspace-list">
      {items.map((order) => (
        <OrderCard key={order.reference} order={order} />
      ))}
    </div>
  ) : (
    <div className="admin-empty">
      <h2>No orders to show</h2>
      <p>
        No fictional orders match this view. Clear the filters to see all test
        orders.
      </p>
    </div>
  );
}
function pageLink(
  kind: "orders" | "inventory",
  filter: string,
  term: string,
  cursor?: string,
) {
  const params = new URLSearchParams({ status: filter });
  if (term) params.set(kind === "orders" ? "reference" : "search", term);
  if (cursor) params.set("after", cursor);
  return `${base}/${kind}?${params}`;
}
function Pagination({
  kind,
  filter,
  term,
  next,
}: {
  kind: "orders" | "inventory";
  filter: string;
  term: string;
  next: string | null;
}) {
  return (
    <nav
      className="commerce-workspace-pagination"
      aria-label={kind === "orders" ? "Order pages" : "Inventory pages"}
    >
      <Link to={pageLink(kind, filter, term)}>First page</Link>
      {next ? (
        <Link
          className="admin-primary-link"
          to={pageLink(kind, filter, term, next)}
        >
          Next page <span aria-hidden="true">→</span>
        </Link>
      ) : (
        <span>End of results</span>
      )}
    </nav>
  );
}
function Orders({
  view,
}: {
  view: Extract<WorkspaceView, { kind: "orders" }>;
}) {
  const navigation = useNavigation();
  return (
    <>
      <Form
        method="get"
        action={`${base}/orders`}
        className="admin-filters commerce-workspace-filters"
        key={`${view.filter}:${view.reference}`}
      >
        <label htmlFor="workspace-order-status">
          Order view
          <select
            id="workspace-order-status"
            name="status"
            defaultValue={view.filter}
          >
            <option value="all">All orders</option>
            <option value="awaiting">Awaiting payment preparation</option>
            <option value="prepared">Payment preparation recorded</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </label>
        <label htmlFor="workspace-reference">
          Full order reference
          <input
            id="workspace-reference"
            name="reference"
            type="search"
            defaultValue={view.reference}
            maxLength={42}
            placeholder="order-…"
            aria-describedby="workspace-reference-help"
          />
        </label>
        <button type="submit" disabled={navigation.state !== "idle"}>
          {navigation.state !== "idle" ? "Loading…" : "Apply filters"}
        </button>
        <Link to={`${base}/orders`}>Clear filters</Link>
      </Form>
      <p id="workspace-reference-help" className="commerce-workspace-muted">
        Copy the complete order reference, including “order-”. Changing filters
        starts at the first page.
      </p>
      <OrderList items={view.items} />
      <Pagination
        kind="orders"
        filter={view.filter}
        term={view.reference}
        next={view.nextCursor}
      />
    </>
  );
}
function OrderDetail({
  view,
}: {
  view: Extract<WorkspaceView, { kind: "order" }>;
}) {
  const { order, lines } = view;
  return (
    <>
      <p>
        <Link to={`${base}/orders`}>← All orders</Link>
      </p>
      <section className="commerce-workspace-card" aria-label="Order summary">
        <h2 className="commerce-workspace-reference">{order.reference}</h2>
        <p>
          Created <Time value={order.createdAt} />
        </p>
        <Facts order={order} />
        <PaymentNotice order={order} />
        <p className="commerce-workspace-muted">
          Reservation deadline: <Time value={order.reserveUntil} />. A past
          deadline alone does not prove that stock was released.
        </p>
      </section>
      <section aria-labelledby="workspace-items-title">
        <h2 id="workspace-items-title">Items at confirmation</h2>
        <p className="commerce-workspace-muted">
          Saved item details and prices for this order.
        </p>
        {lines.length ? (
          <ul className="commerce-workspace-lines">
            {lines.map((line, index) => (
              <li
                className="commerce-workspace-card"
                key={`${line.sku}:${index}`}
              >
                <div className="commerce-workspace-card-heading">
                  <h3>{line.name}</h3>
                  <strong>{formatCad(line.lineTotalCents)} CAD</strong>
                </div>
                <p>
                  {line.colour} · {line.sizeDescription}
                </p>
                <p className="commerce-workspace-reference">SKU: {line.sku}</p>
                <p>
                  {line.quantity} × {formatCad(line.unitPriceCents)} CAD
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="admin-alert" role="alert">
            Item details are unavailable. Ask the developer to check the order
            record.
          </p>
        )}
      </section>
      <dl className="commerce-workspace-totals">
        <div>
          <dt>Items</dt>
          <dd>{formatCad(order.subtotalCents)} CAD</dd>
        </div>
        <div>
          <dt>Delivery</dt>
          <dd>{formatCad(order.shippingCents)} CAD</dd>
        </div>
        <div>
          <dt>Fictional test tax</dt>
          <dd>{formatCad(order.taxCents)} CAD</dd>
        </div>
        <div className="commerce-workspace-total">
          <dt>Order total</dt>
          <dd>{formatCad(order.totalCents)} CAD</dd>
        </div>
      </dl>
    </>
  );
}
function StockCard({ item }: { item: WorkspaceStock }) {
  const availability = !item.active
    ? "Variant disabled"
    : item.productStatus !== "available"
      ? "Product not published for sale"
      : item.websiteAvailable > 0
        ? "Available on website"
        : "No website stock available";
  return (
    <article className="commerce-workspace-card">
      <div className="commerce-workspace-card-heading">
        <h2>{item.productName}</h2>
        <strong>{formatCad(item.priceCents)} CAD</strong>
      </div>
      <p>
        {item.colour} · {item.sizeDescription}
      </p>
      <p className="commerce-workspace-reference">SKU: {item.sku}</p>
      <p className="commerce-workspace-stock-status">{availability}</p>
      <dl className="commerce-workspace-facts commerce-workspace-stock-counts">
        <div>
          <dt>Physical stock</dt>
          <dd>{item.onHand}</dd>
        </div>
        <div>
          <dt>Facebook reserved</dt>
          <dd>{item.facebookReserved}</dd>
        </div>
        <div>
          <dt>Checkout reserved</dt>
          <dd>{item.checkoutReserved}</dd>
        </div>
        <div>
          <dt>Allocated to orders</dt>
          <dd>{item.allocated}</dd>
        </div>
        <div>
          <dt>Website available</dt>
          <dd>{item.websiteAvailable}</dd>
        </div>
      </dl>
    </article>
  );
}
function Inventory({
  view,
}: {
  view: Extract<WorkspaceView, { kind: "inventory" }>;
}) {
  const navigation = useNavigation();
  return (
    <>
      <Form
        method="get"
        action={`${base}/inventory`}
        className="admin-filters commerce-workspace-filters"
        key={`${view.filter}:${view.search}`}
      >
        <label htmlFor="workspace-stock-status">
          Availability
          <select
            id="workspace-stock-status"
            name="status"
            defaultValue={view.filter}
          >
            <option value="all">All variants</option>
            <option value="available">Available on website</option>
            <option value="unavailable">Unavailable on website</option>
          </select>
        </label>
        <label htmlFor="workspace-stock-search">
          Search inventory
          <input
            id="workspace-stock-search"
            name="search"
            type="search"
            defaultValue={view.search}
            placeholder="SKU, product name or colour"
            maxLength={80}
          />
        </label>
        <button type="submit" disabled={navigation.state !== "idle"}>
          {navigation.state !== "idle" ? "Loading…" : "Apply filters"}
        </button>
        <Link to={`${base}/inventory`}>Clear filters</Link>
      </Form>
      <p className="commerce-workspace-muted">
        Only inspected stock is counted. Stock reserved for Facebook or
        checkout, and stock allocated to orders, is not available for another
        website order.
      </p>
      {view.items.length ? (
        <div className="commerce-workspace-list">
          {view.items.map((item) => (
            <StockCard item={item} key={item.variantId} />
          ))}
        </div>
      ) : (
        <div className="admin-empty">
          <h2>No inventory to show</h2>
          <p>
            No variants match this view. Clear the filters to see all test
            inventory.
          </p>
        </div>
      )}
      <Pagination
        kind="inventory"
        filter={view.filter}
        term={view.search}
        next={view.nextCursor}
      />
    </>
  );
}
function Overview({
  view,
}: {
  view: Extract<WorkspaceView, { kind: "overview" }>;
}) {
  const s = view.summary;
  return (
    <>
      <section aria-labelledby="workspace-orders-title">
        <h2 id="workspace-orders-title">Orders at a glance</h2>
        <div className="commerce-workspace-metrics">
          <Link to={`${base}/orders?status=awaiting`}>
            <strong>{s.pendingCount}</strong>
            <span>Awaiting payment preparation</span>
          </Link>
          <Link to={`${base}/orders?status=prepared`}>
            <strong>{s.preparedCount}</strong>
            <span>Payment preparation recorded</span>
          </Link>
          <Link to={`${base}/orders?status=cancelled`}>
            <strong>{s.cancelledCount}</strong>
            <span>Cancelled orders</span>
          </Link>
        </div>
        <p className="commerce-workspace-muted">
          Preparation records an intent only. No funds have been verified by
          this workspace.
        </p>
      </section>
      <section aria-labelledby="workspace-stock-title">
        <div className="commerce-workspace-section-heading">
          <h2 id="workspace-stock-title">Inventory at a glance</h2>
          <Link to={`${base}/inventory`}>View inventory →</Link>
        </div>
        <dl className="commerce-workspace-facts commerce-workspace-card">
          <div>
            <dt>Variants</dt>
            <dd>{s.variantCount}</dd>
          </div>
          <div>
            <dt>Website available units</dt>
            <dd>{s.availableUnits}</dd>
          </div>
          <div>
            <dt>Facebook reserved</dt>
            <dd>{s.facebookUnits}</dd>
          </div>
          <div>
            <dt>Checkout reserved</dt>
            <dd>{s.reservedUnits}</dd>
          </div>
          <div>
            <dt>Allocated to orders</dt>
            <dd>{s.allocatedUnits}</dd>
          </div>
        </dl>
      </section>
      <section aria-labelledby="workspace-recent-title">
        <div className="commerce-workspace-section-heading">
          <h2 id="workspace-recent-title">Recent orders</h2>
          <Link to={`${base}/orders`}>View all orders →</Link>
        </div>
        <OrderList items={view.recentOrders} />
      </section>
    </>
  );
}
export function CommerceWorkspace({ view }: { view: WorkspaceView }) {
  return (
    <AdminShell localReservations>
      <div className="commerce-workspace">
        <p className="admin-kicker">Local test · fictional data · read only</p>
        <div className="admin-page-heading">
          <div>
            <h1>
              {
                {
                  overview: "Commerce workspace",
                  orders: "Orders",
                  order: "Order details",
                  inventory: "Inventory",
                }[view.kind]
              }
            </h1>
            <p>
              Review test orders and inspected inventory. No real purchases,
              refunds or shipments can be made here.
            </p>
          </div>
        </div>
        <nav className="commerce-workspace-nav" aria-label="Commerce workspace">
          <NavLink to={base} end>
            Overview
          </NavLink>
          <NavLink to={`${base}/orders`}>Orders</NavLink>
          <NavLink to={`${base}/inventory`}>Inventory</NavLink>
        </nav>
        <p className="commerce-workspace-muted">
          Observed <Time value={view.observedAt} />. Reload to see the latest
          records.
        </p>
        {view.kind === "overview" ? (
          <Overview view={view} />
        ) : view.kind === "orders" ? (
          <Orders view={view} />
        ) : view.kind === "order" ? (
          <OrderDetail view={view} />
        ) : (
          <Inventory view={view} />
        )}
      </div>
    </AdminShell>
  );
}
