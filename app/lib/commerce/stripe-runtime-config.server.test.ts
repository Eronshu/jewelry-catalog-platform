import { describe, expect, it } from "vitest";
import { stripeRuntimeConfig } from "./stripe-runtime-config.server";
const origin = "http://127.0.0.1:8794";
const base = {
  COMMERCE_MODE: "local-test",
  COMMERCE_CHECKOUT_INSTANCE_ID: "11111111-1111-4111-8111-111111111111",
  COMMERCE_CHECKOUT_ORIGIN: origin,
};
const provider = {
  ...base,
  COMMERCE_STRIPE_SANDBOX: "local-test",
  COMMERCE_STRIPE_NEW_SESSIONS: "local-test",
  COMMERCE_STRIPE_ACCOUNT_ID: "acct_" + "0".repeat(16),
  COMMERCE_STRIPE_TEST_SECRET: "sk_test_" + "0".repeat(24),
};
describe("Stripe runtime boundary", () => {
  it("stays off without explicit provider opt-in and never inherits credentials", () => {
    expect(stripeRuntimeConfig(new Request(origin), base)).toBeNull();
    expect(
      stripeRuntimeConfig(
        new Request(origin),
        Object.assign(Object.create(provider), base),
      ),
    ).toBeNull();
  });
  it("can pause new Sessions while retaining reconciliation configuration", () => {
    expect(stripeRuntimeConfig(new Request(origin), provider)?.canStart).toBe(
      true,
    );
    const paused = stripeRuntimeConfig(new Request(origin), {
      ...provider,
      COMMERCE_STRIPE_NEW_SESSIONS: undefined,
    });
    expect(paused?.canStart).toBe(false);
    expect(paused?.provider.expectedAccountId).toBe(
      provider.COMMERCE_STRIPE_ACCOUNT_ID,
    );
  });
  it.each([
    "https://example.com",
    "http://192.168.1.2:8794",
    "http://127.0.0.1:8795",
  ])("rejects %s before returning configuration", (url) => {
    expect(() => stripeRuntimeConfig(new Request(url), provider)).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });
  it("rejects live-shaped keys and mismatched browser origins without exposing values", () => {
    expect(() =>
      stripeRuntimeConfig(new Request(origin), {
        ...provider,
        COMMERCE_STRIPE_TEST_SECRET: "sk_live_" + "0".repeat(24),
      }),
    ).toThrow(expect.objectContaining({ status: 503 }));
    expect(() =>
      stripeRuntimeConfig(
        new Request(origin, {
          headers: { Origin: "https://elsewhere.example" },
        }),
        provider,
      ),
    ).toThrow(expect.objectContaining({ status: 404 }));
  });
});
