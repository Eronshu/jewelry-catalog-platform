import { Link, useLoaderData, useRouteError } from "react-router";
import type { Route } from "./+types/checkout-confirm";
import { cloudflareContext } from "../cloudflare-context";
import { CheckoutConfirmation } from "../components/storefront/checkout-confirmation";
import {
  loadCheckoutConfirmation,
  checkoutHeaders,
  type CheckoutConfirmationData,
} from "../lib/commerce/checkout-flow.server";
export function headers({ loaderHeaders, actionHeaders }: Route.HeadersArgs) {
  const cookie =
    actionHeaders.get("Set-Cookie") ?? loaderHeaders.get("Set-Cookie");
  return { ...checkoutHeaders, ...(cookie ? { "Set-Cookie": cookie } : {}) };
}
export const meta = () => [
  { title: "Confirm fictional order | Velaform Studio" },
  { name: "robots", content: "noindex, nofollow" },
];
export const loader = ({ request, context }: Route.LoaderArgs) =>
  loadCheckoutConfirmation(request, context.get(cloudflareContext).env);
export default function Confirm() {
  const data = useLoaderData<CheckoutConfirmationData & { error?: string }>();
  return (
    <div className="container commerce-page checkout-page">
      <h1>Confirm your fictional order</h1>
      {data.error ? (
        <p role="alert">{data.error}</p>
      ) : (
        <CheckoutConfirmation data={data} />
      )}
      <p>
        <Link to="/checkout">Back to delivery preview</Link>
      </p>
    </div>
  );
}
export function ErrorBoundary() {
  useRouteError();
  return (
    <div className="container commerce-page">
      <h1>Confirmation unavailable</h1>
      <p>
        This test checkout is only available in the isolated local runner. No
        payment was requested.
      </p>
      <Link to="/cart">Back to cart</Link>
    </div>
  );
}
