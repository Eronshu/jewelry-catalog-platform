import { data } from "react-router";
import type { Route } from "./+types/checkout-quote";
import { cloudflareContext } from "../cloudflare-context";
import { requireLocalCommerce } from "../lib/commerce/environment.server";
import { readCommerceForm } from "../lib/commerce/request.server";
import { CheckoutInputError } from "../lib/commerce/checkout";
import {
  CheckoutRuleError,
  FICTIONAL_CHECKOUT_RULES,
  quoteLocalCheckout,
} from "../lib/commerce/checkout-quote.server";
import { QuoteError } from "../lib/commerce/quote";

const privateHeaders = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
};
export function headers(args?: Route.HeadersArgs) {
  // Single-fetch (.data) responses use this export for final HTTP headers.
  // Keep the method information without weakening the fixed privacy headers.
  const allow =
    args?.actionHeaders.get("Allow") ?? args?.loaderHeaders.get("Allow");
  return { ...privateHeaders, ...(allow ? { Allow: allow } : {}) };
}
export function loader({ request, context }: Route.LoaderArgs) {
  requireLocalCommerce(request, context.get(cloudflareContext).env);
  return data(
    { error: "POST test delivery details to request a quote." },
    { status: 405, headers: { ...privateHeaders, Allow: "POST" } },
  );
}
export async function action({ request, context }: Route.ActionArgs) {
  const env = context.get(cloudflareContext).env;
  requireLocalCommerce(request, env);
  try {
    const form = await readCommerceForm(request);
    let input: unknown;
    try {
      input = JSON.parse(form.get("checkout") ?? "");
    } catch {
      return data(
        { error: "Invalid test quote request." },
        { status: 422, headers: privateHeaders },
      );
    }
    const quote = await quoteLocalCheckout(
      env.DB,
      input,
      FICTIONAL_CHECKOUT_RULES,
    );
    return data({ quote }, { headers: privateHeaders });
  } catch (error) {
    if (error instanceof Response) {
      return new Response(error.body, {
        status: error.status,
        headers: {
          ...privateHeaders,
          ...(error.status === 405 ? { Allow: "POST" } : {}),
        },
      });
    }
    if (error instanceof CheckoutInputError)
      return data(
        { error: error.message, fields: error.fields },
        { status: 422, headers: privateHeaders },
      );
    if (error instanceof CheckoutRuleError)
      return data(
        { error: error.message, code: error.code },
        { status: 422, headers: privateHeaders },
      );
    if (error instanceof QuoteError)
      return data(
        {
          error:
            "Items changed or are unavailable. Review your cart and request a new quote.",
        },
        { status: 409, headers: privateHeaders },
      );
    // Do not log or echo raw input, DB exception details or personal information.
    return data(
      { error: "A test quote could not be loaded. Please retry." },
      { status: 503, headers: privateHeaders },
    );
  }
}
