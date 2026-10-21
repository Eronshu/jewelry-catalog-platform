import { data, isRouteErrorResponse, Link, useRouteError } from "react-router";
import type { Route } from "./+types/checkout";
import { cloudflareContext } from "../cloudflare-context";
import { requireLocalCommerce } from "../lib/commerce/environment.server";
import { DeliveryCheckout } from "../components/storefront/delivery-checkout";

export function headers() {
  return {
    "Cache-Control": "private, no-store",
    "X-Robots-Tag": "noindex, nofollow",
  };
}
export function meta() {
  return [
    { title: "Delivery — local preview | Velaform Studio" },
    { name: "robots", content: "noindex, nofollow" },
  ];
}
export function loader({ request, context }: Route.LoaderArgs) {
  requireLocalCommerce(request, context.get(cloudflareContext).env);
  return data({ localPreview: true }, { headers: headers() });
}
export default function Checkout() {
  return (
    <div className="container commerce-page checkout-page">
      <header className="commerce-intro">
        <p className="commerce-kicker">Local test only</p>
        <h1>Delivery &amp; quote review</h1>
        <p>
          Use fictional contact details and addresses only. No order,
          reservation or payment can be placed here.
        </p>
      </header>
      <DeliveryCheckout />
      <p>
        <Link to="/cart">Back to your cart</Link>
      </p>
    </div>
  );
}
export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <div className="container error-content">
      <h1>
        {isRouteErrorResponse(error) && error.status === 404
          ? "Page not found"
          : "Delivery preview unavailable"}
      </h1>
      <p>
        This delivery preview is available only in the isolated local
        environment. No order or payment has been placed.
      </p>
      <Link to="/cart">Back to your cart</Link>
    </div>
  );
}
