import { checkoutConfig } from "./checkout-config.server";
import type { PayPalSandboxConfig } from "./paypal-sandbox.server";

/** Server-only, pinned to an explicit local Sandbox opt-in. Never loader data. */
export function paypalRuntimeConfig(
  request: Request,
  env: unknown,
): {
  provider: PayPalSandboxConfig;
  canStart: boolean;
  canCapture: boolean;
  webhookId: string | null;
} | null {
  const local = checkoutConfig(request, env);
  const value = (name: string): unknown =>
    Object.getOwnPropertyDescriptor(env, name)?.value;
  if (value("COMMERCE_PAYPAL_SANDBOX") !== "local-test") return null;
  const merchant = value("COMMERCE_PAYPAL_MERCHANT_ID"),
    client = value("COMMERCE_PAYPAL_CLIENT_ID"),
    secret = value("COMMERCE_PAYPAL_CLIENT_SECRET"),
    webhook = value("COMMERCE_PAYPAL_WEBHOOK_ID");
  if (
    typeof merchant !== "string" ||
    !/^[2-9A-HJ-NP-Z]{13}$/.test(merchant) ||
    typeof client !== "string" ||
    !/^[\x21-\x39\x3B-\x7E]{16,512}$/.test(client) ||
    typeof secret !== "string" ||
    !/^[\x21-\x7E]{16,512}$/.test(secret) ||
    (webhook !== undefined &&
      (typeof webhook !== "string" || !/^[A-Za-z0-9]{1,50}$/.test(webhook)))
  )
    throw new Response("PayPal test configuration unavailable", {
      status: 503,
    });
  return {
    provider: {
      ...local,
      enabled: true,
      expectedMerchantId: merchant,
      clientId: client,
      clientSecret: secret,
    },
    canStart: value("COMMERCE_PAYPAL_NEW_ORDERS") === "local-test",
    canCapture: value("COMMERCE_PAYPAL_CAPTURE") === "local-test",
    webhookId: typeof webhook === "string" ? webhook : null,
  };
}
