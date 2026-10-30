import { useEffect, useRef, useState } from "react";
import { Link, useLoaderData, useRevalidator } from "react-router";
import type { Route } from "./+types/checkout-order";
import { cloudflareContext } from "../cloudflare-context";
import { formatCad } from "../lib/format-cad";
import { CheckoutAmounts } from "../components/storefront/checkout-confirmation";
import {
  loadCheckoutOrder,
  checkoutHeaders,
  type OwnedCheckoutOrder,
} from "../lib/commerce/checkout-flow.server";
export const headers = () => checkoutHeaders;
export const meta = () => [
  { title: "Private fictional order | Velaform Studio" },
  { name: "robots", content: "noindex, nofollow" },
];
export const loader = ({ request, context, params }: Route.LoaderArgs) =>
  loadCheckoutOrder(
    request,
    context.get(cloudflareContext).env,
    params.orderId,
  );
export function OwnedOrderView({
  order: initial,
  csrfToken,
  refresh,
}: {
  order: OwnedCheckoutOrder;
  csrfToken: string;
  refresh: () => void;
}) {
  const [order, setOrder] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const release = useRef<string | null>(null);
  const active = useRef(false);
  const alert = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) alert.current?.focus();
  }, [error]);
  async function cancel() {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError("");
    release.current ??= crypto.randomUUID();
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`/checkout/orders/${order.id}/cancel`, {
        method: "POST",
        body: new URLSearchParams({
          csrf: csrfToken,
          releaseKey: release.current,
          expectedVersion: String(initial.version),
        }),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        signal: controller.signal,
        redirect: "error",
      });
      const body = (await response.json()) as {
        order?: OwnedCheckoutOrder;
        error?: string;
      };
      if (!response.ok || !body.order) {
        setError(
          body.error ??
            "Cancellation could not be checked. Retry this same request or refresh status.",
        );
        return;
      }
      setOrder(body.order);
    } catch {
      setError(
        "Cancellation response was lost. Retry the same cancellation or refresh status; do not assume stock was released.",
      );
    } finally {
      window.clearTimeout(timer);
      active.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="checkout-order" aria-label="Your fictional order">
      <p className="commerce-kicker">
        Fictional local order · private browser session
      </p>
      <h1>
        {order.state === "cancelled"
          ? "Test order cancelled"
          : "Unpaid test order"}
      </h1>
      <p style={{ overflowWrap: "anywhere" }}>Reference: {order.id}</p>
      <p>
        <strong>No payment is available or configured.</strong> This order is
        not paid. No real purchase, delivery or customer promise exists.
      </p>
      {error && (
        <div role="alert" tabIndex={-1} ref={alert}>
          <p>{error}</p>
        </div>
      )}
      <ul className="checkout-quote-lines">
        {order.lines.map((line, index) => (
          <li key={index}>
            {line.name} · {line.colour} × {line.quantity}
            <strong>{formatCad(line.lineTotalCents)}</strong>
          </li>
        ))}
      </ul>
      <p>
        Delivery:{" "}
        {(
          {
            pickup: "Pickup",
            local_delivery: "Local delivery",
            shipping: "Canadian shipping",
          } as Record<string, string>
        )[order.delivery] ?? "Test delivery"}
      </p>
      <CheckoutAmounts quote={order} />
      <p>
        {order.state === "cancelled"
          ? "The unpaid reservation has been released."
          : `Test reservation deadline: ${new Date(order.reserveUntil).toLocaleString()}. The local expiry driver releases eligible unpaid items. Refresh to check its result.`}
      </p>
      <div className="checkout-order-actions">
        <button
          className="commerce-secondary-button"
          type="button"
          disabled={busy}
          onClick={refresh}
        >
          Refresh status
        </button>
        {order.state === "pending_payment" &&
          order.paymentState === "not_started" && (
            <button
              className="commerce-secondary-button"
              type="button"
              disabled={busy}
              onClick={() => void cancel()}
            >
              {busy ? "Checking cancellation…" : "Cancel unpaid test order"}
            </button>
          )}
      </div>
      <p>
        <Link to="/checkout/confirm">Your pending orders</Link> ·{" "}
        <Link to="/cart">Your unchanged cart</Link>
      </p>
    </section>
  );
}
export default function Order() {
  const data = useLoaderData<{
    order: OwnedCheckoutOrder;
    csrfToken: string;
    error?: string;
  }>();
  const revalidator = useRevalidator();
  return (
    <div className="container commerce-page checkout-page">
      {data.error ? (
        <>
          <h1>Private test order unavailable</h1>
          <p role="alert">{data.error}</p>
          <Link to="/checkout/confirm">Return to confirmation</Link>
        </>
      ) : (
        <OwnedOrderView
          key={`${data.order.id}:${data.order.version}`}
          order={data.order}
          csrfToken={data.csrfToken}
          refresh={() => void revalidator.revalidate()}
        />
      )}
    </div>
  );
}
export function ErrorBoundary() {
  return (
    <div className="container commerce-page">
      <h1>Private test order unavailable</h1>
      <p>
        Return using the original browser session. An order number alone does
        not grant access.
      </p>
      <Link to="/checkout/confirm">Return to confirmation</Link>
    </div>
  );
}
