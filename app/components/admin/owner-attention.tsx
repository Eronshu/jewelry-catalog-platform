import { Form, Link, NavLink, useNavigation } from "react-router";
import { AdminShell } from "./admin-shell";
import { formatCad } from "../../lib/format-cad";
import type { AttentionPage } from "../../lib/commerce/owner-attention-http.server";
const base = "/admin/commerce/attention";
const labels = {
  all: "All recorded issues",
  payment: "Payment review",
  refund: "Refund review",
  notifications: "Test notification issues",
};
function url(filter: string, reference = "", after?: string | null) {
  const p = new URLSearchParams();
  if (filter !== "all") p.set("status", filter);
  if (reference) p.set("reference", reference);
  if (after) p.set("after", after);
  return base + (p.size ? `?${p}` : "");
}
function Time({ value }: { value: number }) {
  const d = new Date(value);
  return (
    <time dateTime={d.toISOString()}>
      {new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Toronto",
        dateStyle: "medium",
        timeStyle: "short",
      }).format(d)}{" "}
      (Toronto)
    </time>
  );
}
export function OwnerAttention({
  view,
  canOpenRefunds,
  canOpenNotifications,
}: AttentionPage) {
  const navigation = useNavigation();
  return (
    <AdminShell localReservations>
      <div className="commerce-workspace owner-attention">
        <p className="admin-kicker">
          Local test · Fictional records · Read only
        </p>
        <h1>Orders needing attention</h1>
        <p>
          Review unresolved payment records, unfinished refunds and simulated
          notification problems in one place. Opening this page sends no
          payment, refund, query or delivery request.
        </p>
        <nav className="commerce-workspace-nav" aria-label="Commerce workspace">
          <NavLink to="/admin/commerce" end>
            Overview
          </NavLink>
          <NavLink to="/admin/commerce/orders">Orders</NavLink>
          <NavLink to="/admin/commerce/inventory">Inventory</NavLink>
          <NavLink to={base}>Needs attention</NavLink>
        </nav>
        <p className="commerce-workspace-notice">
          These are recorded local facts, not fresh verification with a payment
          provider or bank reconciliation. No issues shown does not guarantee
          that an order is safe to fulfill. Payment and stock protections remain
          in place.
        </p>
        <p>
          Observed <Time value={view.observedAt} />.{" "}
          <Link to={url(view.filter, view.reference)}>
            Reload current records
          </Link>
          . Records may change between pages.
        </p>
        <section aria-label="Recorded issue counts">
          <div className="commerce-workspace-metrics">
            {(
              [
                ["all", view.summary.orderCount, "Orders with recorded issues"],
                ["payment", view.summary.paymentCount, "Need payment review"],
                ["refund", view.summary.refundCount, "Need refund review"],
                [
                  "notifications",
                  view.summary.notificationCount,
                  "Have test notification issues",
                ],
              ] as const
            ).map(([filter, count, label]) => (
              <Link key={filter} to={url(filter, view.reference)}>
                <strong>{count}</strong>
                <span>{label}</span>
              </Link>
            ))}
          </div>
          <p>
            Counts are for distinct orders matching the reference, across all
            pages. One order can appear in more than one category.
          </p>
        </section>
        <Form
          method="get"
          action={base}
          className="commerce-workspace-filters"
          key={`${view.filter}:${view.reference}`}
        >
          <label>
            Issue category
            <select name="status" defaultValue={view.filter}>
              {Object.entries(labels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Complete order reference
            <input
              name="reference"
              type="search"
              defaultValue={view.reference}
              maxLength={42}
              autoComplete="off"
              spellCheck={false}
              placeholder="order-…"
              aria-describedby="attention-reference-help"
            />
          </label>
          <button
            className="commerce-secondary-button"
            type="submit"
            disabled={navigation.state !== "idle"}
          >
            {navigation.state === "idle" ? "Apply filters" : "Loading…"}
          </button>
          <Link to={base}>Clear filters</Link>
        </Form>
        <p id="attention-reference-help">
          Use the complete order reference. There is no customer name or email
          search.
        </p>
        {view.items.length === 0 ? (
          <section className="admin-empty">
            <h2>No recorded issues in this view</h2>
            <p>
              Clear the filters to check other records. This does not confirm
              current provider status, successful delivery or bank settlement.
            </p>
          </section>
        ) : (
          <section
            className="commerce-workspace-list"
            aria-label="Orders with recorded issues"
          >
            {view.items.map((item) => (
              <article className="commerce-workspace-card" key={item.orderId}>
                <div className="commerce-workspace-card-heading">
                  <h2 className="commerce-workspace-reference">
                    <Link
                      to={`/admin/commerce/orders/${encodeURIComponent(item.orderId)}`}
                    >
                      {item.orderId}
                    </Link>
                  </h2>
                  <strong>{formatCad(item.totalCents)} CAD</strong>
                </div>
                <p>
                  Original order total · Created <Time value={item.createdAt} />
                </p>
                <ul className="owner-attention-reasons">
                  {item.paymentReview && (
                    <li>
                      <strong>Payment needs review.</strong> The recorded
                      attempt or later provider activity needs attention. Keep
                      the original attempt and protected stock; this is not
                      proof of a failed charge.
                    </li>
                  )}
                  {item.refundReview && (
                    <li>
                      <strong>Refund needs review.</strong> At least one
                      original refund request is not canonically confirmed. Keep
                      its original identity and budget; do not create a
                      replacement request.
                    </li>
                  )}
                  {item.notificationMissing > 0 && (
                    <li>
                      {item.notificationMissing} verified event
                      {item.notificationMissing === 1 ? "" : "s"} awaiting
                      explicit test notification preparation.
                    </li>
                  )}
                  {item.notificationPending > 0 && (
                    <li>
                      {item.notificationPending} test notification
                      {item.notificationPending === 1 ? "" : "s"} waiting for a
                      simulated outcome.
                    </li>
                  )}
                  {item.notificationFailed > 0 && (
                    <li>
                      {item.notificationFailed} test notification
                      {item.notificationFailed === 1 ? "" : "s"} with a recorded
                      simulated failure.
                    </li>
                  )}
                  {item.notificationExhausted > 0 && (
                    <li>
                      {item.notificationExhausted} reached the three-attempt
                      simulation limit. Review manually; no automatic retry.
                    </li>
                  )}
                </ul>
                {item.notificationPending +
                  item.notificationFailed +
                  item.notificationMissing >
                  0 && (
                  <p>
                    Test inbox only: no actual email is sent. Expired links or
                    exhausted attempts require manual review.
                  </p>
                )}
                <div className="owner-attention-actions">
                  <Link
                    to={`/admin/commerce/orders/${encodeURIComponent(item.orderId)}`}
                  >
                    Open order records
                  </Link>
                  {canOpenRefunds && item.refundReview && (
                    <Link
                      to={`/admin/commerce/orders/${encodeURIComponent(item.orderId)}/refund`}
                    >
                      Review original refund
                    </Link>
                  )}
                  {canOpenNotifications &&
                    item.notificationPending +
                      item.notificationFailed +
                      item.notificationMissing >
                      0 && (
                      <Link
                        to={`/admin/commerce/orders/${encodeURIComponent(item.orderId)}/notifications`}
                      >
                        Open test notifications
                      </Link>
                    )}
                </div>
              </article>
            ))}
          </section>
        )}
        {view.nextCursor && (
          <Link
            className="admin-primary-link"
            to={url(view.filter, view.reference, view.nextCursor)}
          >
            Next page of recorded issues
          </Link>
        )}
      </div>
    </AdminShell>
  );
}
