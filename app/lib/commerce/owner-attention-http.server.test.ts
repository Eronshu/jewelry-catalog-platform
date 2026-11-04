import { beforeEach, expect, it, vi } from "vitest";
import { RouterContextProvider } from "react-router";
import { cloudflareContext } from "../../cloudflare-context";
import { adminPrincipalContext } from "../auth/admin-access.server";
const read = vi.hoisted(() => vi.fn());
vi.mock("./owner-attention.server", () => ({
  OwnerAttentionError: class extends Error {
    constructor(public code: string) {
      super("private-database-details");
    }
  },
  readOwnerAttention: read,
}));
import { loadOwnerAttentionPage } from "./owner-attention-http.server";
import { OwnerAttentionError } from "./owner-attention.server";
const origin = "http://127.0.0.1:8802",
  instanceId = "11111111-1111-4111-8111-111111111111";
let context: RouterContextProvider, env: Record<string, unknown>;
const view = {
  observedAt: 1800000000000,
  filter: "all",
  reference: "",
  nextCursor: null,
  summary: {
    orderCount: 0,
    paymentCount: 0,
    refundCount: 0,
    notificationCount: 0,
  },
  items: [],
};
const request = (query = "", method = "GET") =>
  new Request(origin + "/admin/commerce/attention" + query, { method });
beforeEach(() => {
  read.mockReset().mockResolvedValue(view);
  env = {
    DB: {},
    COMMERCE_MODE: "local-test",
    COMMERCE_CHECKOUT_INSTANCE_ID: instanceId,
    COMMERCE_CHECKOUT_ORIGIN: origin,
    COMMERCE_OWNER_ATTENTION_UI: "local-test",
  };
  context = new RouterContextProvider();
  context.set(adminPrincipalContext, {
    email: "attention@example.invalid",
    sub: "fictional-owner",
  });
  context.set(cloudflareContext, {
    env: env as unknown as Env,
    ctx: {} as ExecutionContext,
  });
});
async function denial(run: () => Promise<Response>, status: number) {
  try {
    await run();
    throw new Error("unexpectedsuccess");
  } catch (e) {
    expect(e).toBeInstanceOf(Response);
    const r = e as Response;
    expect(r.status).toBe(status);
    expect(r.headers.get("Cache-Control")).toBe("private, no-store");
    expect(r.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(await r.text()).not.toContain("private-database-details");
    return r;
  }
}
it("requires independent Admin identity before any model access", async () => {
  const unauth = new RouterContextProvider();
  unauth.set(cloudflareContext, {
    env: env as unknown as Env,
    ctx: {} as ExecutionContext,
  });
  await denial(() => loadOwnerAttentionPage(request(), unauth), 401);
  expect(read).not.toHaveBeenCalled();
});
it.each(["flag", "mode", "instance", "origin"])(
  "fails closed on unavailable %s before DB reads",
  async (name) => {
    if (name === "flag") delete env.COMMERCE_OWNER_ATTENTION_UI;
    if (name === "mode") env.COMMERCE_MODE = "production";
    if (name === "instance") env.COMMERCE_CHECKOUT_INSTANCE_ID = "bad";
    if (name === "origin")
      env.COMMERCE_CHECKOUT_ORIGIN = "http://127.0.0.1:8888";
    await denial(() => loadOwnerAttentionPage(request(), context), 404);
    expect(read).not.toHaveBeenCalled();
  },
);
it.each(["POST", "PUT", "DELETE"])(
  "rejects %s without a model call and keeps GET Allow",
  async (method) => {
    const r = await denial(
      () => loadOwnerAttentionPage(request("", method), context),
      405,
    );
    expect(r!.headers.get("Allow")).toBe("GET");
    expect(read).not.toHaveBeenCalled();
  },
);
it("allows no caller scope/account/email or duplicate query fields", async () => {
  for (const query of [
    "?instanceId=other",
    "?email=real%40example.com",
    "?status=all&status=payment",
    "?ownerHash=guess",
    "?token=secret",
  ]) {
    await denial(() => loadOwnerAttentionPage(request(query), context), 400);
  }
  expect(read).not.toHaveBeenCalled();
});
it("passes only trusted scope and bounded-query inputs; links reflect independent UI availability", async () => {
  env.COMMERCE_OWNER_REFUND_UI = "local-test";
  const r = await loadOwnerAttentionPage(
    request(
      "?status=refund&reference=order-22222222-2222-4222-8222-222222222222&after=cursor",
    ),
    context,
  );
  expect(r.status).toBe(200);
  expect(r.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  expect(r.headers.has("Set-Cookie")).toBe(false);
  expect(await r.json()).toEqual({
    view,
    canOpenRefunds: true,
    canOpenNotifications: false,
  });
  expect(read.mock.calls[0]).toEqual([
    env.DB,
    { mode: "local-test", instanceId, canonicalOrigin: origin },
    {
      filter: "refund",
      reference: "order-22222222-2222-4222-8222-222222222222",
      after: "cursor",
    },
  ]);
});
it("keeps arbitrary model errors and invalid filters private", async () => {
  read.mockRejectedValueOnce(new OwnerAttentionError("invalid_request"));
  await denial(
    () => loadOwnerAttentionPage(request("?status=guess"), context),
    400,
  );
  read.mockRejectedValueOnce(new Error("private-database-details"));
  await denial(() => loadOwnerAttentionPage(request(), context), 503);
});
