import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { StripeCheckout } from "../../app/components/storefront/stripe-checkout";
import type { OwnedStripePayment } from "../../app/lib/commerce/owned-stripe.server";
import type { OwnedCheckoutOrder } from "../../app/lib/commerce/checkout-flow.server";

/** Presentation only. No Worker, database, credentials, provider transport or saved state. */
export function StripeCheckoutPreview() {
  const [search] = useSearchParams();
  const scene = search.get("scene") ?? "ready";
  const payment: OwnedStripePayment =
    scene === "paid"
      ? { state: "paid", canStart: false, canQuery: false }
      : scene === "review"
        ? { state: "review_required", canStart: false, canQuery: false }
        : { state: "not_started", canStart: true, canQuery: false };
  const [order, setOrder] = useState<OwnedCheckoutOrder>({
    id: "order-11111111-1111-4111-8111-111111111111",
    state: "pending_payment",
    paymentState: "not_started",
    version: 1,
    reserveUntil: Date.now() + 600000,
    totalCents: 4400,
    subtotalCents: 2500,
    shippingCents: 1500,
    taxCents: 400,
    delivery: "shipping",
    lines: [
      {
        name: "Fictional necklace",
        colour: "Gold-tone",
        quantity: 1,
        lineTotalCents: 2500,
      },
    ],
  });
  return (
    <main className="container commerce-page checkout-page">
      <h1>Stripe checkout presentation</h1>
      <p role="note">
        Layout fixture only: no payment, database or provider connection. The
        button’s endpoint is unconnected here; it cannot test checkout.
      </p>
      <p>Fictional necklace · Gold-tone × 1</p>
      <p>Test total: CAD $44.00</p>
      <StripeCheckout
        key={scene}
        order={order}
        initial={payment}
        csrfToken={"0".repeat(64)}
        returned={scene !== "ready"}
        onOrderChanged={setOrder}
        onBusyChanged={() => {}}
      />
      <nav className="checkout-order-actions" aria-label="Presentation scenes">
        <Link to="?scene=ready">Ready</Link>
        <Link to="?scene=paid">Verified test example</Link>
        <Link to="?scene=review">Review required</Link>
        <Link to="/admin/commerce">Owner workspace</Link>
      </nav>
    </main>
  );
}
