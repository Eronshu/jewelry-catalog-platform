import { beforeEach, expect, it, vi } from "vitest";
import { RouterContextProvider } from "react-router";
import { cloudflareContext } from "../../cloudflare-context";
import { adminPrincipalContext } from "../auth/admin-access.server";
const calls = vi.hoisted(() => ({
  read: vi.fn(),
  apply: vi.fn(),
  lookup: vi.fn(),
  status: vi.fn(),
}));
vi.mock("./order-notification.server", () => ({
  OwnerNotificationError: class extends Error {
    constructor(public code: string) {
      super("Rejected");
    }
  },
  readOwnerNotifications: calls.read,
  applyOwnerNotification: calls.apply,
  lookupOwnerNotificationCommand: calls.lookup,
  readNotificationStatus: calls.status,
}));
import {
  actOwnerNotificationPage,
  loadOwnerNotificationPage,
  actNotificationStatus,
  loadNotificationStatusLanding,
} from "./order-notification-http.server";
const origin = "http://127.0.0.1:8801",
  instanceId = "11111111-1111-4111-8111-111111111111",
  orderId = "order-22222222-2222-4222-8222-222222222222",
  requestId = "33333333-3333-4333-8333-333333333333",
  actor = { email: "notification@example.invalid", sub: "test-owner" };
const receipt = {
  testOnly: true,
  requestId,
  orderId,
  operation: "prepare",
  recorded: true,
};
let env: Record<string, unknown>, context: RouterContextProvider;
function request(intent = "apply", extra: Record<string, string> = {}) {
  return new Request(
    `${origin}/admin/commerce/orders/${orderId}/notifications/commands`,
    {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        intent,
        requestId,
        operation: "prepare",
        notificationId: "",
        ...extra,
      }),
    },
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  env = {
    DB: {},
    COMMERCE_MODE: "local-test",
    COMMERCE_CHECKOUT_INSTANCE_ID: instanceId,
    COMMERCE_CHECKOUT_ORIGIN: origin,
    COMMERCE_OWNER_NOTIFICATIONS_UI: "local-test",
    COMMERCE_OWNER_NOTIFICATIONS_WRITES: "local-test",
    COMMERCE_ORDER_STATUS_LINKS: "local-test",
    COMMERCE_NOTIFICATION_LINK_SECRET: "a".repeat(64),
  };
  context = new RouterContextProvider();
  context.set(adminPrincipalContext, actor);
  context.set(cloudflareContext, {
    env: env as unknown as Env,
    ctx: {} as ExecutionContext,
  });
  calls.apply.mockReset().mockResolvedValue(receipt);
  calls.lookup.mockResolvedValue({ state: "recorded", receipt });
  calls.read.mockResolvedValue({
    orderId,
    canPrepare: false,
    notifications: [],
  });
  calls.status.mockResolvedValue({
    orderId,
    state: "confirmed",
    paymentState: "succeeded",
    fulfillment: "ready_to_pack",
    totalCents: 4400,
    refundedCents: 1500,
    delivery: "shipping",
  });
});
it("requires Admin and local UI/config before any database or link-key access", async () => {
  const unauth = new RouterContextProvider();
  unauth.set(cloudflareContext, {
    env: env as unknown as Env,
    ctx: {} as ExecutionContext,
  });
  expect(
    (await actOwnerNotificationPage(request(), unauth, orderId)).status,
  ).toBe(401);
  delete env.COMMERCE_OWNER_NOTIFICATIONS_UI;
  expect(
    (await actOwnerNotificationPage(request(), context, orderId)).status,
  ).toBe(404);
  expect(calls.apply).not.toHaveBeenCalled();
  expect(calls.read).not.toHaveBeenCalled();
});
it("returns private JSON and accepts only canonical scope/operator/order plus requested action", async () => {
  const r = await actOwnerNotificationPage(request(), context, orderId);
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ state: "recorded", receipt });
  expect(r.headers.get("Content-Type")).toContain("application/json");
  expect(r.headers.get("Cache-Control")).toBe("private, no-store");
  expect(r.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(calls.apply.mock.calls[0].slice(1, 4)).toEqual([
    {
      mode: "local-test",
      instanceId,
      canonicalOrigin: origin,
      linkSecret: "a".repeat(64),
    },
    actor,
    { requestId, orderId, operation: "prepare", notificationId: null },
  ]);
});
it.each(["actor", "instance", "writes", "secret", "UI"])(
  "rechecks %s at the final mutation boundary",
  async (change) => {
    calls.apply.mockImplementation(async (...args) => {
      if (change === "actor")
        context.set(adminPrincipalContext, {
          sub: "other",
          email: "other@example.invalid",
        });
      if (change === "instance")
        env.COMMERCE_CHECKOUT_INSTANCE_ID =
          "44444444-4444-4444-8444-444444444444";
      if (change === "writes") delete env.COMMERCE_OWNER_NOTIFICATIONS_WRITES;
      if (change === "secret")
        env.COMMERCE_NOTIFICATION_LINK_SECRET = "b".repeat(64);
      if (change === "UI") delete env.COMMERCE_OWNER_NOTIFICATIONS_UI;
      await args[5]();
      return receipt;
    });
    expect(
      (await actOwnerNotificationPage(request(), context, orderId)).status,
    ).not.toBe(200);
  },
);
it("original receipt lookup remains available with writes paused and key unavailable", async () => {
  delete env.COMMERCE_OWNER_NOTIFICATIONS_WRITES;
  delete env.COMMERCE_NOTIFICATION_LINK_SECRET;
  expect(
    (await actOwnerNotificationPage(request("lookup"), context, orderId))
      .status,
  ).toBe(200);
  expect(
    (await actOwnerNotificationPage(request(), context, orderId)).status,
  ).toBe(503);
  expect(calls.apply).not.toHaveBeenCalled();
});
it.each<Record<string, string>>([
  { recipient: "real@example.com" },
  { amount: "999" },
  { token: "a".repeat(64) },
  { operation: "email" },
  { intent: "deliver" },
])("rejects injected fields/actions %j before core", async (extra) => {
  expect(
    (await actOwnerNotificationPage(request("apply", extra), context, orderId))
      .status,
  ).toBe(422);
  expect(calls.apply).not.toHaveBeenCalled();
});
it("rejects cross-origin, duplicate keys, GET and query parameters on command resources", async () => {
  const cross = request();
  cross.headers.set("Origin", "https://other.invalid");
  expect((await actOwnerNotificationPage(cross, context, orderId)).status).toBe(
    404,
  );
  expect(
    (
      await actOwnerNotificationPage(
        new Request(request().url),
        context,
        orderId,
      )
    ).status,
  ).toBe(405);
  const duplicate = new Request(request().url, {
    method: "POST",
    headers: request().headers,
    body: (await request().text()) + "&requestId=" + requestId,
  });
  expect(
    (await actOwnerNotificationPage(duplicate, context, orderId)).status,
  ).toBe(400);
  expect(calls.apply).not.toHaveBeenCalled();
});
it("landing GET is generic, DB-free and never exchanges a bearer for ownership", () => {
  const r = loadNotificationStatusLanding(
    new Request(`${origin}/checkout/status`),
    env as unknown as Env,
  );
  expect(r.status).toBe(200);
  expect(r.headers.has("Set-Cookie")).toBe(false);
  expect(calls.status).not.toHaveBeenCalled();
});
function statusRequest(token = "a".repeat(64)) {
  return new Request(`${origin}/checkout/status/read`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ token }),
  });
}
it("reads minimal status through same-origin POST body without issuing a session cookie", async () => {
  const r = await actNotificationStatus(statusRequest(), env as unknown as Env);
  expect(r.status).toBe(200);
  expect(r.headers.has("Set-Cookie")).toBe(false);
  expect(calls.status.mock.calls[0].slice(1)).toEqual([
    { mode: "local-test", instanceId, canonicalOrigin: origin },
    "a".repeat(64),
  ]);
  const text = await r.text();
  for (const hidden of [
    "recipient",
    "owner_hash",
    "actor",
    "provider",
    "a".repeat(64),
  ])
    expect(text).not.toContain(hidden);
});
it("missing, malformed, revoked and expired links use the same private denial", async () => {
  calls.status.mockResolvedValue(null);
  const malformed = await actNotificationStatus(
    statusRequest("bad"),
    env as unknown as Env,
  );
  const missing = await actNotificationStatus(
    statusRequest(),
    env as unknown as Env,
  );
  expect(malformed.status).toBe(404);
  expect(missing.status).toBe(404);
  expect(await malformed.text()).toBe(await missing.text());
  const query = new Request(
    `${origin}/checkout/status/read?token=${"a".repeat(64)}`,
    {
      method: "POST",
      headers: statusRequest().headers,
      body: "token=" + "a".repeat(64),
    },
  );
  expect(
    (await actNotificationStatus(query, env as unknown as Env)).status,
  ).toBe(404);
});
it("read failures never echo exception details, raw bearers or secrets", async () => {
  calls.status.mockRejectedValue(
    new Error("secret-token-and-database-details"),
  );
  const r = await actNotificationStatus(statusRequest(), env as unknown as Env);
  expect(r.status).toBe(503);
  expect(await r.text()).not.toContain("secret-token");
  await expect(
    loadOwnerNotificationPage(
      new Request(
        `${origin}/admin/commerce/orders/${orderId}/notifications?email=anything`,
      ),
      context,
      orderId,
    ),
  ).rejects.toMatchObject({ status: 422 });
});
