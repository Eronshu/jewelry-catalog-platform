import type { Route } from "./+types/checkout-order-paypal";
import { cloudflareContext } from "../cloudflare-context";
import {
  checkoutCommandGet,
  checkoutHeaders,
} from "../lib/commerce/checkout-flow.server";
import { actPayPalCheckout } from "../lib/commerce/paypal-checkout.server";
export function headers({ loaderHeaders, actionHeaders }: Route.HeadersArgs) {
  const allow = actionHeaders.get("Allow") ?? loaderHeaders.get("Allow");
  return { ...checkoutHeaders, ...(allow ? { Allow: allow } : {}) };
}
export const loader = ({ request, context }: Route.LoaderArgs) =>
  checkoutCommandGet(request, context.get(cloudflareContext).env);
export const action = ({ request, context, params }: Route.ActionArgs) =>
  actPayPalCheckout(
    request,
    context.get(cloudflareContext).env,
    params.orderId,
  );
