import { RouterContextProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { cloudflareContext } from "../cloudflare-context";
import { headers, loader } from "./checkout";

describe("checkout page local-only boundary", () => {
  it.each([
    ["http://localhost/checkout", ""],
    ["http://localhost/checkout", "live"],
    ["https://example.com/checkout", "local-test"],
  ])("rejects %s in %s before DB access", (url, mode) => {
    const db = { prepare: vi.fn() };
    const context = new RouterContextProvider();
    context.set(cloudflareContext, {
      env: { DB: db, COMMERCE_MODE: mode } as unknown as Env,
      ctx: {} as ExecutionContext,
    });
    expect(() =>
      loader({
        request: new Request(url),
        context,
        params: {},
        url: new URL(url),
        pattern: "/checkout",
      }),
    ).toThrow(expect.objectContaining({ status: 404 }));
    expect(db.prepare).not.toHaveBeenCalled();
  });
  it("does not load customer/stock data or set a cookie, and stays uncacheable", () => {
    const context = new RouterContextProvider();
    context.set(cloudflareContext, {
      env: { COMMERCE_MODE: "local-test" } as unknown as Env,
      ctx: {} as ExecutionContext,
    });
    const result = loader({
      request: new Request("http://localhost/checkout"),
      context,
      params: {},
      url: new URL("http://localhost/checkout"),
      pattern: "/checkout",
    });
    expect(result.data).toEqual({ localPreview: true, placesKey: null });
    expect(new Headers(result.init?.headers).get("Set-Cookie")).toBeNull();
    expect(headers()).toEqual({
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
    });
  });
});
