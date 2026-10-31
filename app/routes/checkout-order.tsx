import { useEffect, useRef, useState } from "react";
import {
  Link,
  useLoaderData,
  useRevalidator,
  useSearchParams,
} from "react-router";
import { StripeCheckout } from "../components/storefront/stripe-checkout";
import type { OwnedStripePayment } from "../lib/commerce/owned-stripe.server";
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
  canPreparePayment = false,
  stripe = null,
  returned = false,
}: {
  order: OwnedCheckoutOrder;
  csrfToken: string;
  refresh: () => void;
  canPreparePayment?: boolean;
  stripe?: OwnedStripePayment | null;
  returned?: boolean;
}) {
  const [order, setOrder] = useState(initial);
  const [operationInFlight, setOperationInFlight] = useState<
    "cancel" | "prepare" | null
  >(null);
  const [stripeBusy, setStripeBusy] = useState(false);
  const [stripeTouched, setStripeTouched] = useState(false);
  const busy = operationInFlight !== null || stripeBusy;
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState<"cancel" | "prepare" | null>(null);
  const release = useRef<string | null>(null);
  const preparation = useRef<string | null>(null);
  const active = useRef(false);
  const alert = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) alert.current?.focus();
  }, [error]);
  async function submit(operation: "cancel" | "prepare") {
    if (active.current) return;
    active.current = true;
    setOperationInFlight(operation);
    setError("");
    const requestKey = operation === "cancel" ? release : preparation;
    requestKey.current ??= crypto.randomUUID();
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(
        `/checkout/orders/${order.id}/${operation === "cancel" ? "cancel" : "prepare-payment"}`,
        {
          method: "POST",
          body: new URLSearchParams({
            csrf: csrfToken,
            ...(operation === "cancel"
              ? { releaseKey: requestKey.current }
              : { requestId: requestKey.current }),
            expectedVersion: String(initial.version),
          }),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          signal: controller.signal,
          redirect: "error",
        },
      );
      const body = (await response.json()) as {
        order?: OwnedCheckoutOrder;
        error?: string;
        retrySame?: boolean;
      };
      if (!response.ok || !body.order || body.order.id !== order.id) {
        setUncertain(
          response.status >= 500 || body.retrySame ? operation : null,
        );
        setError(
          body.error ??
            "The result could not be checked. Retry this same request or refresh status.",
        );
        return;
      }
      setOrder(body.order);
      setUncertain(null);
    } catch {
      setUncertain(operation);
      setError(
        operation === "cancel"
          ? "Cancellation response was lost. Retry the same cancellation or refresh status; do not assume stock was released."
          : "Preparation response was lost. Retry the same preparation or refresh status. Do not start another payment attempt; no provider payment request is sent by this feature.",
      );
    } finally {
      window.clearTimeout(timer);
      active.current = false;
      setOperationInFlight(null);
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
          : order.paymentState === "succeeded"
            ? "Test order confirmed"
            : order.paymentState === "processing"
              ? stripe
                ? "Test payment in progress"
                : "Test payment attempt recorded"
              : "Unpaid test order"}
      </h1>
      <p style={{ overflowWrap: "anywhere" }}>Reference: {order.id}</p>
      {!stripe && order.paymentState !== "succeeded" && (
        <p>
          <strong>No payment is available or configured.</strong> Payment has
          not been verified on this order. No real purchase, delivery or
          customer promise exists.
        </p>
      )}
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
      {!stripe && order.paymentState === "processing" && (
        <p role="status">
          <strong>A test payment attempt is recorded.</strong> This page has no
          active provider connection. Stock stays protected pending payment
          review; unpaid cancellation and expiry cannot release it.
        </p>
      )}
      {canPreparePayment &&
        order.state === "pending_payment" &&
        order.paymentState === "not_started" && (
          <p>
            Optional Stripe test preparation records an intent and protects
            these fictional items. It sends no provider request and takes no
            payment.
          </p>
        )}
      <p>
        {order.state === "cancelled"
          ? "The unpaid reservation has been released."
          : order.paymentState === "succeeded"
            ? "Test payment was verified and items were allocated. No real purchase or delivery is created."
            : order.paymentState === "processing"
              ? "Refresh to check the current test preparation. The local unpaid expiry driver does not release attempted orders."
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
          order.paymentState === "not_started" &&
          !stripeTouched && (
            <button
              className="commerce-secondary-button"
              type="button"
              disabled={busy || uncertain === "prepare"}
              onClick={() => void submit("cancel")}
            >
              {operationInFlight === "cancel"
                ? "Checking cancellation…"
                : "Cancel unpaid test order"}
            </button>
          )}
        {canPreparePayment &&
          order.state === "pending_payment" &&
          order.paymentState === "not_started" && (
            <button
              className="commerce-secondary-button"
              type="button"
              disabled={busy || uncertain === "cancel"}
              onClick={() => void submit("prepare")}
            >
              {operationInFlight === "prepare"
                ? "Checking preparation…"
                : uncertain === "prepare"
                  ? "Retry the same Stripe preparation"
                  : "Prepare Stripe test attempt"}
            </button>
          )}
      </div>
      {stripe && order.state !== "cancelled" && (
        <StripeCheckout
          order={order}
          initial={stripe}
          csrfToken={csrfToken}
          returned={returned}
          disabled={operationInFlight !== null || uncertain !== null}
          onOrderChanged={setOrder}
          onBusyChanged={(value) => {
            setStripeBusy(value);
            if (value) setStripeTouched(true);
          }}
        />
      )}
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
    canPreparePayment: boolean;
    stripe?: OwnedStripePayment | null;
    error?: string;
  }>();
  const revalidator = useRevalidator();
  const [search] = useSearchParams();
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
          canPreparePayment={data.canPreparePayment}
          stripe={data.stripe}
          returned={["success", "cancel"].includes(
            search.get("stripe_return") ?? "",
          )}
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
