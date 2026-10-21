import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cloudflareContext } from "../cloudflare-context";
import { action, loader, headers } from "./cart";
import { resolveShoppingCart } from "../lib/commerce/shopping.server";

vi.mock("../lib/commerce/shopping.server", () => ({
  resolveShoppingCart: vi.fn(),
}));
function args(request: Request, mode?: string) {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, {
    env: { DB: {}, ...(mode ? { COMMERCE_MODE: mode } : {}) } as Env,
    ctx: {} as ExecutionContext,
  });
  return {
    request,
    context,
    params: {},
    url: new URL(request.url),
    pattern: "/cart",
  };
}
function post(lines: unknown, extras = {}) {
  return new Request("http://localhost/cart", {
    method: "POST",
    headers: { Origin: "http://localhost" },
    body: new URLSearchParams({
      intent: "resolve",
      lines: JSON.stringify(lines),
      ...extras,
    }),
  });
}
beforeEach(() => vi.clearAllMocks());
describe("local customer cart read-only boundary", () => {
  it("denies normal and remote requests before querying storage", async () => {
    for (const input of [
      args(post([])),
      args(post([]), "live"),
      args(new Request("https://example.com/cart"), "local-test"),
    ]) {
      await expect(
        Promise.resolve().then(() => loader(input)),
      ).rejects.toMatchObject({ status: 404 });
      await expect(action(input)).rejects.toMatchObject({ status: 404 });
    }
    expect(resolveShoppingCart).not.toHaveBeenCalled();
  });
  it("has no session/order side effect on navigation and keeps responses private", () => {
    const result = loader(
      args(new Request("http://localhost/cart"), "local-test"),
    );
    expect(new Headers(result.init?.headers).get("Set-Cookie")).toBeNull();
    expect(headers()).toEqual({
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
    });
  });
  it("requires Origin and rejects duplicate fields or non-read intents", async () => {
    const request = post([]);
    request.headers.delete("Origin");
    await expect(action(args(request, "local-test"))).rejects.toMatchObject({
      status: 403,
    });
    const repeated = new Request("http://localhost/cart", {
      method: "POST",
      headers: {
        Origin: "http://localhost",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "intent=resolve&lines=[]&lines=[]",
    });
    await expect(action(args(repeated, "local-test"))).rejects.toMatchObject({
      status: 400,
    });
    expect(
      (await action(args(post([], { intent: "reserve" }), "local-test"))).init
        ?.status,
    ).toBe(422);
    expect(resolveShoppingCart).not.toHaveBeenCalled();
  });
  it.each([
    null,
    [{ variantId: "v", quantity: -1 }],
    [{ variantId: "v", quantity: 1.5 }],
    [{ variantId: "v", quantity: 21 }],
    [
      { variantId: "v", quantity: 1 },
      { variantId: "v", quantity: 2 },
    ],
    Array.from({ length: 21 }, (_, i) => ({ variantId: `v${i}`, quantity: 1 })),
  ])("rejects malformed or oversized cart %j", async (input) => {
    expect((await action(args(post(input), "local-test"))).init?.status).toBe(
      422,
    );
    expect(resolveShoppingCart).not.toHaveBeenCalled();
  });
  it("discards submitted prices, addresses and stock before resolving current data", async () => {
    await action(
      args(
        post([
          {
            variantId: "v1",
            quantity: 2,
            priceCents: 1,
            address: "fake",
            available: 999,
          },
        ]),
        "local-test",
      ),
    );
    expect(resolveShoppingCart).toHaveBeenCalledWith({}, [
      { variantId: "v1", quantity: 2 },
    ]);
  });
  it("does not expose database errors", async () => {
    vi.mocked(resolveShoppingCart).mockRejectedValueOnce(
      new Error("secret SQL details"),
    );
    const result = await action(
      args(post([{ variantId: "v1", quantity: 1 }]), "local-test"),
    );
    expect(result.init?.status).toBe(503);
    expect(JSON.stringify(result)).not.toContain("secret SQL");
  });
});
