import type { RouterContextProvider } from "react-router";
import { cloudflareContext } from "../../cloudflare-context";
import { requireAdmin } from "../auth/admin-access.server";
import { checkoutConfig } from "./checkout-config.server";
import { workspaceHeaders } from "./workspace.server";
import {
  OwnerAttentionError,
  readOwnerAttention,
} from "./owner-attention.server";
import type { AttentionFilter, AttentionView } from "./owner-attention";
export const attentionHeaders = {
  ...workspaceHeaders,
  "X-Content-Type-Options": "nosniff",
};
export type AttentionPage = {
  view: AttentionView;
  canOpenRefunds: boolean;
  canOpenNotifications: boolean;
};
const enabled = (env: unknown, name: string) =>
  !!env && Object.getOwnPropertyDescriptor(env, name)?.value === "local-test";
export async function loadOwnerAttentionPage(
  request: Request,
  context: Readonly<RouterContextProvider>,
) {
  try {
    requireAdmin(context);
    const env = context.get(cloudflareContext).env,
      c = checkoutConfig(request, env);
    if (!enabled(env, "COMMERCE_OWNER_ATTENTION_UI"))
      throw new Response(null, { status: 404 });
    if (request.method !== "GET") throw new Response(null, { status: 405 });
    const params = new URL(request.url).searchParams;
    if (
      [...params.keys()].some(
        (k) =>
          !["status", "reference", "after"].includes(k) ||
          params.getAll(k).length !== 1,
      )
    )
      throw new Response(null, { status: 400 });
    const view = await readOwnerAttention(
      env.DB,
      {
        mode: c.mode,
        instanceId: c.instanceId,
        canonicalOrigin: c.canonicalOrigin,
      },
      {
        filter: (params.get("status") ?? "all") as AttentionFilter,
        reference: params.get("reference") ?? "",
        after: params.get("after"),
      },
    );
    return Response.json(
      {
        view,
        canOpenRefunds: enabled(env, "COMMERCE_OWNER_REFUND_UI"),
        canOpenNotifications: enabled(env, "COMMERCE_OWNER_NOTIFICATIONS_UI"),
      } satisfies AttentionPage,
      { headers: attentionHeaders },
    );
  } catch (error) {
    const status =
      error instanceof Response
        ? error.status
        : error instanceof OwnerAttentionError
          ? (
              { invalid_request: 400, conflict: 409, unavailable: 503 } as const
            )[error.code]
          : 503;
    throw Response.json(
      {
        error:
          "The local attention view is unavailable. No order or payment change was requested.",
      },
      {
        status,
        headers: {
          ...attentionHeaders,
          ...(status === 405 ? { Allow: "GET" } : {}),
        },
      },
    );
  }
}
