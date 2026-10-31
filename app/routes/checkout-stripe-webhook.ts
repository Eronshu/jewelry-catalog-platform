import type { Route } from "./+types/checkout-stripe-webhook";
import { cloudflareContext } from "../cloudflare-context";
import { actStripeWebhook } from "../lib/commerce/stripe-checkout.server";
export const loader = ({ request, context }: Route.LoaderArgs) =>
  actStripeWebhook(request, context.get(cloudflareContext).env);
export const action = ({ request, context }: Route.ActionArgs) =>
  actStripeWebhook(request, context.get(cloudflareContext).env);
