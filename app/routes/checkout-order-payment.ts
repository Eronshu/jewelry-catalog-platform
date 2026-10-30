import type { Route } from "./+types/checkout-order-payment";
import { cloudflareContext } from "../cloudflare-context";
import {
  checkoutCommandGet,
  checkoutHeaders,
  prepareCheckoutPayment,
} from "../lib/commerce/checkout-flow.server";

export function headers({ loaderHeaders, actionHeaders }: Route.HeadersArgs) {
  const allow = actionHeaders.get("Allow") ?? loaderHeaders.get("Allow");
  return { ...checkoutHeaders, ...(allow ? { Allow: allow } : {}) };
}
export const loader = ({ request, context }: Route.LoaderArgs) =>
  checkoutCommandGet(request, context.get(cloudflareContext).env);
export const action = ({ request, context, params }: Route.ActionArgs) =>
  prepareCheckoutPayment(
    request,
    context.get(cloudflareContext).env,
    params.orderId,
  );
