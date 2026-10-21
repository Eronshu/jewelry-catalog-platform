import { createRequestHandler, RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { cloudflareContext } from "../cloudflare-context";
import * as QuoteRoute from "./checkout-quote";

const route = {
  id: "routes/checkout-quote",
  path: "checkout/quote",
  module: QuoteRoute,
};
const handler = createRequestHandler(
  {
    entry: { module: { default: () => new Response("Test document") } },
    routes: { [route.id]: route },
    assets: {
      entry: { imports: [], module: "/entry.js" },
      routes: {
        [route.id]: {
          id: route.id,
          path: route.path,
          module: "/quote.js",
          hasLoader: true,
          hasAction: true,
        },
      },
      url: "/manifest.js",
      version: "test",
    },
    publicPath: "/",
    assetsBuildDirectory: "build/client",
    future: {},
    ssr: true,
    isSpaMode: false,
    prerender: [],
    routeDiscovery: { mode: "initial", manifestPath: "/manifest.js" },
  } as unknown as Parameters<typeof createRequestHandler>[0],
  "test",
);

describe("checkout quote final React Router HTTP headers", () => {
  it.each([
    ["GET", "/checkout/quote"],
    ["DELETE", "/checkout/quote"],
    ["GET", "/checkout/quote.data"],
    ["DELETE", "/checkout/quote.data"],
  ])("keeps Allow on %s %s", async (method, path) => {
    const context = new RouterContextProvider();
    context.set(cloudflareContext, {
      env: { COMMERCE_MODE: "local-test" } as unknown as Env,
      ctx: {} as ExecutionContext,
    });
    const response = await handler(
      new Request(`http://localhost${path}`, { method }),
      context,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });
});
