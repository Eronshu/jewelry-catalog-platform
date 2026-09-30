// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { createRoutesStub, RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Route } from "./+types/shop";
import { cloudflareContext } from "../cloudflare-context";
import { listPublicProducts } from "../lib/db/products.server";

import Shop, { ErrorBoundary, loader } from "./shop";

vi.mock("../lib/db/products.server", () => ({
  listPublicProducts: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

async function renderRoute(routeLoader: typeof loader) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
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

  await act(async () => {
    root.render(<Stub initialEntries={["/shop"]} />);
  });
  const html = container.innerHTML;
  await act(async () => root.unmount());
  return html;
}

describe("Shop route error handoff", () => {
  it("routes a catalog-read failure through the loader to the Shop 503 boundary", async () => {
    const internalError = new Error("SQL and binding details");
    const serverLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(listPublicProducts).mockRejectedValueOnce(internalError);

    const html = await renderRoute(loader);

    expect(listPublicProducts).toHaveBeenCalledOnce();
    expect(serverLog).toHaveBeenCalledWith(
      "Shop catalog load failed",
      internalError,
    );
    expect(html).toContain("We couldn’t load the shop");
    expect(html).toContain('href="/shop"');
    expect(html).toContain("Try again");
    expect(html).not.toContain("SQL and binding details");
  });

  it("renders an unrelated route error with the generic fallback", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const html = await renderRoute((async () => {
      throw new Response(null, { status: 503, statusText: "Other service" });
    }) as typeof loader);

    expect(html).toContain("Something went wrong");
    expect(html).not.toContain("We couldn’t load the shop");
    expect(html).not.toContain("Try again");
  });
});
