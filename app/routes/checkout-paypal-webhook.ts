import type { Route } from "./+types/checkout-paypal-webhook";
import { cloudflareContext } from "../cloudflare-context";
import { actPayPalWebhook } from "../lib/commerce/paypal-checkout.server";
export const loader = ({ request, context }: Route.LoaderArgs) =>
  actPayPalWebhook(request, context.get(cloudflareContext).env);
export const action = ({ request, context }: Route.ActionArgs) =>
  actPayPalWebhook(request, context.get(cloudflareContext).env);
