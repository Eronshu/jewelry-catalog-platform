import { beforeEach, expect, it, vi } from "vitest";
import { RouterContextProvider } from "react-router";
import { cloudflareContext } from "../../cloudflare-context";
import { adminPrincipalContext } from "../auth/admin-access.server";
const calls = vi.hoisted(() => ({
  read: vi.fn(),
  apply: vi.fn(),
  lookup: vi.fn(),
}));
vi.mock("./owner-return.server", () => ({
  OwnerReturnError: class extends Error {
    constructor(public readonly code: string) {
      super("Return rejected");
    }
  },
  readOwnerReturn: calls.read,
  applyOwnerReturn: calls.apply,
  lookupOwnerReturnCommand: calls.lookup,
}));
import {
  actOwnerReturnPage,
  loadOwnerReturnPage,
} from "./owner-return-http.server";
const instance = "11111111-1111-4111-8111-111111111111",
  requestId = "22222222-2222-4222-8222-222222222222",
  orderId = "order-33333333-3333-4333-8333-333333333333",
  origin = "http://127.0.0.1:8792";
const actor = {
  email: "return@example.invalid",
  sub: "fictional-return-owner",
};
const input = {
  requestId,
  orderId,
  operation: "inspect_sellable",
  expectedVersion: 5,
  expectedStockHash: "a".repeat(64),
  acknowledge: true,
};
const receipt = {
  testOnly: true,
  ...input,
  result: "sellable_received",
  recordedAt: 1800000000000,
  replayed: false,
};
let env: Record<string, unknown>, context: RouterContextProvider;
beforeEach(() => {
  vi.clearAllMocks();
  env = {
    DB: {},
    COMMERCE_MODE: "local-test",
    COMMERCE_CHECKOUT_INSTANCE_ID: instance,
    COMMERCE_CHECKOUT_ORIGIN: origin,
    COMMERCE_OWNER_RETURN_UI: "local-test",
    COMMERCE_OWNER_RETURN_WRITES: "local-test",
  };
  context = new RouterContextProvider();
  context.set(adminPrincipalContext, actor);
  context.set(cloudflareContext, {
    env: env as unknown as Env,
    ctx: {} as ExecutionContext,
  });
  calls.apply.mockReset().mockResolvedValue(receipt);
  calls.lookup.mockReset().mockResolvedValue({ state: "recorded", receipt });
});
const request = (intent = "apply", extra: Record<string, string> = {}) =>
  new Request(`${origin}/admin/commerce/orders/${orderId}/return/commands`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      intent,
      requestId,
      operation: "inspect_sellable",
      expectedVersion: "5",
      expectedStockHash: "a".repeat(64),
      acknowledge: "true",
      ...extra,
    }),
  });
it("passes only canonical action identity/version/hash and exposes private JSON without provider configuration", async () => {
  const r = await actOwnerReturnPage(request(), context, orderId);
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ state: "recorded", receipt });
  expect(r.headers.get("Cache-Control")).toBe("private, no-store");
  expect(calls.apply.mock.calls[0].slice(1, 4)).toEqual([
    { mode: "local-test", instanceId: instance },
    actor,
    input,
  ]);
});
it.each(["actor", "instance", "writes"])(
  "rejects changed %s immediately before the stock mutation",
  async (change) => {
    calls.apply.mockImplementation(async (...args) => {
      await Promise.resolve();
      if (change === "actor")
        context.set(adminPrincipalContext, {
          email: "other@example.invalid",
          sub: "other-approved-human",
        });
      if (change === "instance")
        env.COMMERCE_CHECKOUT_INSTANCE_ID =
          "44444444-4444-4444-8444-444444444444";
      if (change === "writes") delete env.COMMERCE_OWNER_RETURN_WRITES;
      await args[5]();
      return receipt;
    });
    expect((await actOwnerReturnPage(request(), context, orderId)).status).toBe(
      503,
    );
  },
);
it("rejects client quantities, balances and invented operations before storage", async () => {
  const extras: Record<string, string>[] = [
    { quantity: "100" },
    { onHand: "900" },
    { operation: "receive" },
    { expectedStockHash: "broken" },
  ];
  for (const extra of extras)
    expect(
      (await actOwnerReturnPage(request("apply", extra), context, orderId))
        .status,
    ).toBe(422);
  expect(calls.apply).not.toHaveBeenCalled();
  expect(calls.lookup).not.toHaveBeenCalled();
});
it("permits only original receipt lookup with new actions paused", async () => {
  delete env.COMMERCE_OWNER_RETURN_WRITES;
  expect((await actOwnerReturnPage(request(), context, orderId)).status).toBe(
    503,
  );
  expect(
    (await actOwnerReturnPage(request("lookup"), context, orderId)).status,
  ).toBe(200);
  expect(calls.lookup.mock.calls[0].slice(1)).toEqual([
    { mode: "local-test", instanceId: instance },
    actor,
    input,
  ]);
  expect(calls.apply).not.toHaveBeenCalled();
});
it("retains 404 when a scoped order is absent instead of rendering incomplete data", async () => {
  calls.read.mockResolvedValue(null);
  await expect(
    loadOwnerReturnPage(
      new Request(`${origin}/admin/commerce/orders/${orderId}/return`),
      context,
      orderId,
    ),
  ).rejects.toMatchObject({ status: 404 });
});
