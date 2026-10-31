import { checkoutConfig } from "./checkout-config.server";
import type { StripeSandboxConfig } from "./stripe-sandbox.server";

/** Server-only, explicit loopback opt-in. A browser flag can never enable dispatch. */
export function stripeRuntimeConfig(
  request: Request,
  env: unknown,
): {
  provider: StripeSandboxConfig;
  canStart: boolean;
  signingSecrets: string[];
} | null {
  const local = checkoutConfig(request, env);
  const value = (name: string): unknown =>
    Object.getOwnPropertyDescriptor(env, name)?.value;
  if (value("COMMERCE_STRIPE_SANDBOX") !== "local-test") return null;
  const account = value("COMMERCE_STRIPE_ACCOUNT_ID");
  const secret = value("COMMERCE_STRIPE_TEST_SECRET");
  const signing = value("COMMERCE_STRIPE_SIGNING_SECRET");
  if (
    typeof account !== "string" ||
    !/^acct_[A-Za-z0-9]{8,100}$/.test(account) ||
    typeof secret !== "string" ||
    !/^sk_test_[A-Za-z0-9]{16,240}$/.test(secret) ||
    (signing !== undefined &&
      (typeof signing !== "string" ||
        !/^whsec_[A-Za-z0-9]{16,240}$/.test(signing)))
  )
    throw new Response("Test payment configuration unavailable", {
      status: 503,
    });
  return {
    provider: {
      ...local,
      enabled: true,
      expectedAccountId: account,
      testSecretKey: secret,
    },
    canStart: value("COMMERCE_STRIPE_NEW_SESSIONS") === "local-test",
    signingSecrets: typeof signing === "string" ? [signing] : [],
  };
}
