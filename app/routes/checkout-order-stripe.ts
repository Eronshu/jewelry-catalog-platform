import type { Route } from "./+types/checkout-order-stripe";
import { cloudflareContext } from "../cloudflare-context";
import {
  checkoutCommandGet,
  checkoutHeaders,
} from "../lib/commerce/checkout-flow.server";
import { actStripeCheckout } from "../lib/commerce/stripe-checkout.server";
export function headers({ loaderHeaders, actionHeaders }: Route.HeadersArgs) {
  const allow = actionHeaders.get("Allow") ?? loaderHeaders.get("Allow");
  return { ...checkoutHeaders, ...(allow ? { Allow: allow } : {}) };
}
export const loader = ({ request, context }: Route.LoaderArgs) =>
  checkoutCommandGet(request, context.get(cloudflareContext).env);
export const action = ({ request, context, params }: Route.ActionArgs) =>
  actStripeCheckout(
    request,
    context.get(cloudflareContext).env,
    params.orderId,
  );
