import { beforeEach, expect, it, vi } from "vitest";
import { RouterContextProvider } from "react-router";
import { cloudflareContext } from "../../cloudflare-context";
import { adminPrincipalContext } from "../auth/admin-access.server";
const operations = vi.hoisted(() => ({
  read: vi.fn(),
  stripeStart: vi.fn(),
  stripeQuery: vi.fn(),
  paypalStart: vi.fn(),
  paypalQuery: vi.fn(),
  lookup: vi.fn(),
}));
vi.mock("./owner-refund.server", () => ({
  OwnerRefundError: class extends Error {
    constructor(public readonly code: string) {
      super("Refund rejected");
    }
  },
  readOwnerRefund: operations.read,
  startOwnerStripeRefund: operations.stripeStart,
  reconcileOwnerStripeRefund: operations.stripeQuery,
  startOwnerPayPalRefund: operations.paypalStart,
  reconcileOwnerPayPalRefund: operations.paypalQuery,
  lookupOwnerRefundCommand: operations.lookup,
}));
import { actOwnerRefundPage } from "./owner-refund-http.server";
const orderId = "order-33333333-3333-4333-8333-333333333333",
  requestId = "22222222-2222-4222-8222-222222222222",
  instance = "11111111-1111-4111-8111-111111111111",
  origin = "http://127.0.0.1:8792";
const actor = {
  email: "refund@example.invalid",
  sub: "fictional-refund-owner",
};
const receipt = {
  testOnly: true,
  requestId,
  orderId,
  state: "pending",
  amountCents: 4400,
  refundedCents: 0,
};
let env: Record<string, unknown>, context: RouterContextProvider;
const transport = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.clearAllMocks();
  env = {
    DB: {},
    COMMERCE_MODE: "local-test",
    COMMERCE_CHECKOUT_INSTANCE_ID: instance,
    COMMERCE_CHECKOUT_ORIGIN: origin,
    COMMERCE_OWNER_REFUND_UI: "local-test",
    COMMERCE_OWNER_REFUND_WRITES: "local-test",
    COMMERCE_OWNER_REFUND_QUERIES: "local-test",
    COMMERCE_PAYPAL_SANDBOX: "local-test",
    COMMERCE_PAYPAL_MERCHANT_ID: "A".repeat(13),
    COMMERCE_PAYPAL_CLIENT_ID: "0".repeat(32),
    COMMERCE_PAYPAL_CLIENT_SECRET: "1".repeat(32),
  };
  context = new RouterContextProvider();
  context.set(adminPrincipalContext, actor);
  context.set(cloudflareContext, {
    env: env as unknown as Env,
    ctx: {} as ExecutionContext,
  });
  operations.read.mockResolvedValue({ provider: "paypal" });
  for (const operation of [
    operations.paypalStart,
    operations.paypalQuery,
    operations.stripeStart,
    operations.stripeQuery,
  ])
    operation.mockReset().mockResolvedValue(receipt);
  operations.lookup
    .mockReset()
    .mockResolvedValue({ state: "recorded", receipt });
});
const request = (intent = "start", extra?: Record<string, string>) =>
  new Request(`${origin}/admin/commerce/orders/${orderId}/refund/commands`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      intent,
      requestId,
      expectedVersion: "3",
      acknowledge: "true",
      ...extra,
    }),
  });
const call = (intent = "start", extra?: Record<string, string>) =>
  actOwnerRefundPage(request(intent, extra), context, orderId, transport);
it("chooses the original PayPal capture on the server even when unrelated Stripe settings are invalid", async () => {
  env.COMMERCE_STRIPE_SANDBOX = "local-test";
  const response = await call();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ state: "recorded", receipt });
  expect(operations.paypalStart).toHaveBeenCalledOnce();
  const args = operations.paypalStart.mock.calls[0];
  expect(args[1]).toEqual({ mode: "local-test", instanceId: instance });
  expect(args[2]).toEqual(actor);
  expect(args[3]).toEqual({
    requestId,
    orderId,
    expectedVersion: 3,
    acknowledge: true,
  });
  expect(args[4].expectedMerchantId).toBe(env.COMMERCE_PAYPAL_MERCHANT_ID);
  expect(operations.stripeStart).not.toHaveBeenCalled();
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(JSON.stringify(receipt)).not.toContain(
    String(env.COMMERCE_PAYPAL_CLIENT_SECRET),
  );
});
it("keeps existing Stripe dispatch on its original account rather than falling back to PayPal", async () => {
  operations.read.mockResolvedValue({ provider: "stripe" });
  env.COMMERCE_STRIPE_SANDBOX = "local-test";
  env.COMMERCE_STRIPE_ACCOUNT_ID = `acct_${"0".repeat(16)}`;
  env.COMMERCE_STRIPE_TEST_SECRET = `sk_test_${"0".repeat(24)}`;
  expect((await call()).status).toBe(200);
  expect(operations.stripeStart).toHaveBeenCalledOnce();
  expect(operations.paypalStart).not.toHaveBeenCalled();
});
it("rejects client provider/amount overrides before looking up any order", async () => {
  for (const extra of [{ provider: "stripe" }, { amountCents: "1" }] as Record<
    string,
    string
  >[])
    expect((await call("start", extra)).status).toBe(422);
  expect(operations.read).not.toHaveBeenCalled();
  expect(operations.paypalStart).not.toHaveBeenCalled();
});
it("queries the original PayPal request while new writes are paused without another start", async () => {
  delete env.COMMERCE_OWNER_REFUND_WRITES;
  expect((await call("query")).status).toBe(200);
  expect(operations.paypalQuery).toHaveBeenCalledOnce();
  expect(operations.paypalStart).not.toHaveBeenCalled();
  expect(operations.paypalQuery.mock.calls[0][3]).toEqual({
    requestId,
    orderId,
    expectedVersion: 3,
    acknowledge: true,
  });
});
it.each(["merchant", "credentials", "writes", "actor", "instance"])(
  "rechecks %s after asynchronous provider waits before mutation",
  async (change) => {
    operations.paypalStart.mockImplementation(async (...args) => {
      await Promise.resolve();
      if (change === "merchant")
        env.COMMERCE_PAYPAL_MERCHANT_ID = "B".repeat(13);
      if (change === "credentials")
        env.COMMERCE_PAYPAL_CLIENT_SECRET = "2".repeat(32);
      if (change === "writes") delete env.COMMERCE_OWNER_REFUND_WRITES;
      if (change === "actor")
        context.set(adminPrincipalContext, {
          email: "another@example.invalid",
          sub: "another-approved-human",
        });
      if (change === "instance")
        env.COMMERCE_CHECKOUT_INSTANCE_ID =
          "44444444-4444-4444-8444-444444444444";
      await args[7]();
      return receipt;
    });
    expect((await call()).status).toBe(503);
    expect(transport).not.toHaveBeenCalled();
  },
);
it("never uses the other provider when the original provider is not configured", async () => {
  operations.read.mockResolvedValue({ provider: "stripe" });
  expect((await call()).status).toBe(503);
  expect(operations.stripeStart).not.toHaveBeenCalled();
  expect(operations.paypalStart).not.toHaveBeenCalled();
});
it("keeps local receipt lookup independent of both credential and write/query opt-ins", async () => {
  for (const key of Object.keys(env))
    if (
      key.startsWith("COMMERCE_PAYPAL") ||
      key.endsWith("_WRITES") ||
      key.endsWith("_QUERIES")
    )
      delete env[key];
  expect((await call("lookup")).status).toBe(200);
  expect(operations.lookup).toHaveBeenCalledOnce();
  expect(operations.read).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});
