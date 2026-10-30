import { isLocalCommerceEnabled } from "./environment.server";
import type { TestCheckoutSessionConfig } from "./checkout-session.server";

/** Only the isolated runner supplies these settings. They are scope, not a
 * claim about Cloudflare binding identity or a merchant environment. */
export function checkoutConfig(
  request: Request,
  env: unknown,
): TestCheckoutSessionConfig {
  const settings = env as Record<string, unknown> | null;
  const value = (name: string) =>
    settings && Object.getOwnPropertyDescriptor(settings, name)?.value;
  const instanceId = value("COMMERCE_CHECKOUT_INSTANCE_ID");
  const canonicalOrigin = value("COMMERCE_CHECKOUT_ORIGIN");
  if (
    !isLocalCommerceEnabled(request, env) ||
    typeof instanceId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      instanceId,
    ) ||
    typeof canonicalOrigin !== "string" ||
    !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(canonicalOrigin) ||
    new URL(request.url).origin !== canonicalOrigin
  )
    throw new Response("Not Found", { status: 404 });
  return { mode: "local-test", instanceId, canonicalOrigin };
}
export function checkoutExpiryConfigured(
  request: Request,
  env: unknown,
): boolean {
  try {
    checkoutConfig(request, env);
    const settings = env as Record<string, unknown>;
    return (
      settings.COMMERCE_CHECKOUT_EXPIRY === "local-test" &&
      typeof settings.COMMERCE_LOCAL_EXPIRY_TOKEN === "string" &&
      /^[a-f0-9]{64}$/.test(settings.COMMERCE_LOCAL_EXPIRY_TOKEN)
    );
  } catch {
    return false;
  }
}

export function checkoutAvailable(request: Request, env: unknown): boolean {
  return (
    checkoutExpiryConfigured(request, env) &&
    (env as Record<string, unknown>).COMMERCE_CHECKOUT_NEW_ORDERS ===
      "local-test"
  );
}
