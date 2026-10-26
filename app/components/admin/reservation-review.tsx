import { useEffect, useRef } from "react";
import { Form, Link, useNavigation, useRevalidator } from "react-router";
import type { ReservationReviewView } from "../../lib/commerce/reservation-review-request.server";
import { AdminShell } from "./admin-shell";

export const reservationReviewPath = "/admin/commerce/reservations";
type Order = Extract<
  ReservationReviewView,
  { kind: "detail" }
>["result"]["order"];

const orderLabels: Record<string, string> = {
  pending_payment: "Awaiting payment",
  confirmed: "Confirmed in test records",
  cancelled: "Cancelled",
  closed: "Closed in test records",
};
const paymentLabels: Record<string, string> = {
  not_started: "Not started",
  processing: "Processing — needs reconciliation",
  succeeded: "Recorded as successful — needs reconciliation",
  failed: "Failed in test records",
  unknown: "Unknown — needs reconciliation",
};
const fulfillmentLabels: Record<string, string> = {
  none: "Not started",
  ready_to_pack: "Ready to pack in test records",
  held: "On hold",
  completed: "Completed in test records",
};
const historyLabels: Record<string, string> = {
  reserve: "Stock reserved",
  cancel: "Reservation cancelled",
  expire: "Reservation expired",
};
const reasons: Record<string, { title: string; next: string }> = {
  overdue_unpaid: {
    title: "Unpaid reservation past its deadline",
    next: "Developer: inspect the expiry run and stock history. The deadline alone does not prove stock was released.",
  },
  payment_review: {
    title: "Payment needs review",
    next: "Developer: reconcile payment facts before releasing stock or trying payment again. This screen does not check a payment provider.",
  },
  fulfillment_held: {
    title: "Fulfillment is on hold",
    next: "Owner: check the goods and fulfillment issue with the developer. Keep the order on hold until stock and payment facts are resolved.",
  },
};

function ReviewTime({ value }: { value: number }) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return <>Time unavailable</>;
  return (
    <time dateTime={date.toISOString()}>
      {new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Toronto",
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date)}{" "}
      (Toronto)
    </time>
  );
}

function OrderSummary({ order }: { order: Order }) {
  return (
    <>
      <dl className="reservation-facts">
        <div className="reservation-reference">
          <dt>Order reference</dt>
          <dd>{order.id}</dd>
        </div>
        <div>
          <dt>Order</dt>
          <dd>{orderLabels[order.state] ?? "Needs developer review"}</dd>
        </div>
        <div>
          <dt>Payment</dt>
          <dd>
            {paymentLabels[order.paymentState] ?? "Needs developer review"}
          </dd>
        </div>
        <div>
          <dt>Fulfillment</dt>
          <dd>
            {fulfillmentLabels[order.fulfillment] ?? "Needs developer review"}
          </dd>
        </div>
        <div>
          <dt>Reservation deadline</dt>
          <dd>
            <ReviewTime value={order.reserveUntil} />
          </dd>
        </div>
      </dl>
      {order.reasons.length ? (
        <ul className="reservation-reasons" aria-label="Reasons and next steps">
          {order.reasons.map((reason) => (
            <li key={reason}>
              <strong>
                {reasons[reason]?.title ?? "Needs developer review"}
              </strong>
              <p>
                {reasons[reason]?.next ??
                  "Developer: inspect the test record before taking any action."}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p>
          No attention reason is currently recorded. This does not verify
          payment, delivery or released stock.
        </p>
      )}
    </>
  );
}

export function ReservationReview({ view }: { view: ReservationReviewView }) {
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const heading = useRef<HTMLHeadingElement>(null);
  const busy = navigation.state !== "idle" || revalidator.state !== "idle";
  useEffect(() => {
    heading.current?.focus();
  }, [view]);
  const detail = view.kind === "detail" ? view.result : null;
  const errorText =
    view.kind === "error"
      ? {
          400: "Use a complete test order reference, or return to the first page.",
          404: "No test reservation was found for that reference.",
          405: "This screen only supports viewing test reservations.",
          503: "Test reservations are temporarily unavailable. Try refreshing; contact the developer if the problem continues.",
        }[view.status]
      : null;
  return (
    <AdminShell localReservations>
      <div className="reservation-review">
        <div className="admin-page-heading">
          <div>
            <p className="admin-kicker">Local test · Read only</p>
            <h1 tabIndex={-1} ref={heading}>
              Test reservation review
            </h1>
            <p>Check reservations that need attention.</p>
          </div>
          <button
            className="reservation-button"
            type="button"
            disabled={busy}
            onClick={() => {
              void revalidator.revalidate();
            }}
          >
            Refresh results
          </button>
        </div>
        <aside
          className="reservation-notice"
          aria-label="Test and privacy boundary"
        >
          <strong>Fictional orders only. No real payment.</strong>
          <p>
            Viewing or refreshing never changes stock, payments or orders.
            Customer details and payment credentials are not shown. This is not
            a customer checkout or a recovery tool.
          </p>
        </aside>
        <Form
          method="get"
          action={reservationReviewPath}
          className="admin-filters reservation-search"
        >
          <label htmlFor="reservation-reference">
            Find a test order by its full reference
            <input
              id="reservation-reference"
              name="reference"
              type="text"
              required
              maxLength={42}
              autoComplete="off"
              spellCheck={false}
              placeholder="order-…"
              aria-describedby="reservation-search-help"
            />
          </label>
          <button disabled={busy}>Find order</button>
          <Link to={reservationReviewPath}>First page</Link>
        </Form>
        <p id="reservation-search-help" className="reservation-help">
          Copy the complete order reference from the local test flow. Do not
          enter an email address, name or address.
        </p>
        <p role="status" className="reservation-update">
          {busy ? (
            "Updating… The previous result is shown until the update finishes."
          ) : view.kind !== "error" ? (
            <>
              Last checked: <ReviewTime value={view.result.observedAt} />
            </>
          ) : (
            "No current result. Refresh or return to the first page."
          )}
        </p>
        <div aria-busy={busy}>
          {errorText && (
            <div className="admin-alert" role="alert">
              <h2>Unable to show this result</h2>
              <p>{errorText}</p>
              <Link to={reservationReviewPath}>Return to the first page</Link>
            </div>
          )}
          {view.kind === "list" && (
            <>
              <p>
                This list shows overdue unpaid reservations, pending orders with
                payment activity, and fulfillment holds. It is not a complete
                order or payment report.
              </p>
              {view.result.items.length ? (
                <ul
                  className="reservation-list"
                  aria-label="Reservations needing attention"
                >
                  {view.result.items.map((order) => (
                    <li key={order.id} className="reservation-card">
                      <h2>
                        <Link
                          to={`${reservationReviewPath}?${new URLSearchParams({ reference: order.id })}`}
                        >
                          Test order · {order.id.slice(-8)}
                        </Link>
                      </h2>
                      <OrderSummary order={order} />
                    </li>
                  ))}
                </ul>
              ) : (
                <section className="admin-empty">
                  <h2>No reservations on this page</h2>
                  <p>
                    There are no matching attention records here. This does not
                    mean all orders are paid or stock has been released. Use
                    First page to check again from the beginning.
                  </p>
                </section>
              )}
              {view.result.nextCursor && (
                <nav
                  className="reservation-pagination"
                  aria-label="Reservation pages"
                >
                  <Link
                    to={`${reservationReviewPath}?${new URLSearchParams({ after: JSON.stringify(view.result.nextCursor) })}`}
                  >
                    Next page (up to 25 reservations)
                  </Link>
                </nav>
              )}
              <p className="reservation-help">
                Pages reflect current records, not a frozen report. Refresh
                updates this page; First page also finds newly eligible records
                before this page.
              </p>
            </>
          )}
          {detail && (
            <>
              <section
                className="reservation-card"
                aria-labelledby="reservation-detail-title"
              >
                <h2 id="reservation-detail-title">
                  Test order · {detail.order.id.slice(-8)}
                </h2>
                <OrderSummary order={detail.order} />
                <p className="reservation-help">
                  Record version: {detail.order.version}
                </p>
              </section>
              <section
                className="reservation-card"
                aria-labelledby="reservation-items-title"
              >
                <h2 id="reservation-items-title">Reserved items</h2>
                <p>
                  Item references and quantities only; product names and
                  customer details are not included in this review.
                </p>
                <ul className="reservation-items">
                  {detail.lines.map((line) => (
                    <li key={line.position}>
                      <span>Item reference: {line.variantId}</span>
                      <strong>Quantity: {line.quantity}</strong>
                    </li>
                  ))}
                </ul>
                {detail.lines.length === 0 && (
                  <p>No item lines were returned.</p>
                )}
              </section>
              <section
                className="reservation-card"
                aria-labelledby="reservation-history-title"
              >
                <h2 id="reservation-history-title">Recent recorded changes</h2>
                {detail.history.length ? (
                  <ol className="reservation-history">
                    {detail.history.map((event, index) => (
                      <li key={index}>
                        <strong>
                          {historyLabels[event.kind] ??
                            "Recorded change — ask the developer"}
                        </strong>
                        <span>
                          <ReviewTime value={event.occurredAt} /> · Previous
                          record version: {event.expectedVersion}
                        </span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p>
                    No changes were returned. This is not proof that no payment
                    or stock activity occurred.
                  </p>
                )}
                {detail.historyTruncated && (
                  <p>
                    Only the latest 25 changes are shown. Ask the developer for
                    a full investigation.
                  </p>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </AdminShell>
  );
}
