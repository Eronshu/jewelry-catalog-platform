import { createRequestHandler, RouterContextProvider } from "react-router";

import { cloudflareContext } from "../app/cloudflare-context";
import {
  handleLocalExpiry,
  LOCAL_EXPIRY_PATH,
} from "../app/lib/commerce/expiry-trigger.server";
import {
  adminPrincipalContext,
  authenticateAdmin,
  isAdminPath,
} from "../app/lib/auth/admin-access.server";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

type RouteHandler = typeof requestHandler;

function adminDenial(status: 401 | 403 | 503): Response {
  const title =
    status === 403
      ? "You do not have access to this area"
      : status === 503
        ? "Admin is temporarily unavailable"
        : "Admin access is required";
  const detail =
    status === 503
      ? "Please try again later."
      : "Please use an approved account to open the admin area.";
  return new Response(
    `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{margin:0;background:#f3f0ea;color:#171717;font:1rem/1.5 system-ui,sans-serif}main{max-width:38rem;margin:12vh auto;padding:1.5rem}h1{line-height:1.1}a{display:inline-block;min-height:44px;padding:.7rem 0;color:#681c29}:focus-visible{outline:2px solid #681c29;outline-offset:4px}</style><main><h1>${title}</h1><p>${detail}</p><a href="/">Return to the site</a></main></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-store",
      },
    },
  );
}

export async function handleWorkerRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  handleRoute: RouteHandler = requestHandler,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (pathname === LOCAL_EXPIRY_PATH) return handleLocalExpiry(request, env);
  const context = new RouterContextProvider();
  context.set(cloudflareContext, { env, ctx });

  if (isAdminPath(pathname)) {
    let result;
    try {
      result = await authenticateAdmin(request, env);
    } catch {
      return adminDenial(503);
    }
    if (result.status !== "authorized") {
      return adminDenial(
        result.status === "unauthenticated"
          ? 401
          : result.status === "unauthorized"
            ? 403
            : 503,
      );
    }
    context.set(adminPrincipalContext, result.principal);
  }

  let response: Response;
  try {
    response = await handleRoute(request, context);
  } catch (error) {
    if (isAdminPath(pathname)) return adminDenial(503);
    throw error;
  }
  if (
    !isAdminPath(pathname) &&
    pathname.startsWith("/media/products/") &&
    response.headers.get("Cache-Control")?.startsWith("public,")
  ) {
    return response;
  }

  // Workers Cache is enabled for public image responses. Keep every other
  // application response, including all admin responses, out of it.
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env, ctx) {
    return handleWorkerRequest(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
