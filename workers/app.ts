import { createRequestHandler, RouterContextProvider } from "react-router";

import { cloudflareContext } from "../app/cloudflare-context";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  async fetch(request, env, ctx) {
    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env, ctx });

    const response = await requestHandler(request, context);
    if (
      new URL(request.url).pathname.startsWith("/media/products/") &&
      response.headers.get("Cache-Control")?.startsWith("public,")
    ) {
      return response;
    }

    // Workers Cache is enabled for public image responses. Keep every other
    // application response, including future admin responses, out of it.
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "private, no-store");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
} satisfies ExportedHandler<Env>;
