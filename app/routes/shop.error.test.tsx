// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { createRoutesStub, RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Route } from "./+types/shop";
import { cloudflareContext } from "../cloudflare-context";
import { shopData } from "../lib/shop-data.server";
import Shop, { ErrorBoundary, loader } from "./shop";

vi.mock("../lib/shop-data.server", () => ({ shopData: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

async function renderRoute(routeLoader: typeof loader) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const context = new RouterContextProvider();
  context.set(cloudflareContext, {
    env: { DB: {} as D1Database } as Env,
    ctx: {} as ExecutionContext,
  });
  const Stub = createRoutesStub(
    [
      {
        path: "/shop",
        Component: Shop,
        ErrorBoundary,
        loader: (args) => routeLoader(args as Route.LoaderArgs),
      },
    ],
    context,
  );
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<Stub initialEntries={["/shop"]} />));
  const html = host.innerHTML;
  await act(async () => root.unmount());
  host.remove();
  return html;
}

describe("Shop route error handoff", () => {
  it("shows generic retry when a catalog read fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(shopData).mockRejectedValueOnce(new Error("private SQL detail"));
    const html = await renderRoute(loader);
    expect(log).toHaveBeenCalled();
    expect(html).toContain("We couldn’t load the shop");
    expect(html).toContain("Try again");
    expect(html).not.toContain("private SQL detail");
  });

  it("uses generic fallback for an unrelated error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const html = await renderRoute((async () => {
      throw new Response(null, { status: 503, statusText: "Other service" });
    }) as typeof loader);
    expect(html).toContain("Something went wrong");
    expect(html).not.toContain("We couldn’t load the shop");
  });
});
