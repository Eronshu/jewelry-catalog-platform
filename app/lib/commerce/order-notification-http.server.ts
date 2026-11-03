import type { RouterContextProvider } from "react-router";
import { cloudflareContext } from "../../cloudflare-context";
import { requireAdmin } from "../auth/admin-access.server";
import { checkoutConfig } from "./checkout-config.server";
import { workspaceHeaders } from "./workspace.server";
import { readCommerceForm } from "./request.server";
import {
  OwnerNotificationError,
  readOwnerNotifications,
  applyOwnerNotification,
  lookupOwnerNotificationCommand,
  readNotificationStatus,
} from "./order-notification.server";
import type {
  NotificationConfig,
  OwnerNotificationInput,
  OwnerNotificationDetail,
} from "./order-notification";
export const notificationHeaders = {
  ...workspaceHeaders,
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
const enabled = (env: unknown, key: string) =>
  !!env && Object.getOwnPropertyDescriptor(env, key)?.value === "local-test";
const json = (v: unknown, status = 200) =>
  Response.json(v, { status, headers: notificationHeaders });
function reject(e: unknown) {
  const status =
    e instanceof Response
      ? e.status
      : e instanceof OwnerNotificationError
        ? (
            {
              invalid_request: 422,
              not_found: 404,
              conflict: 409,
              unavailable: 503,
            } as const
          )[e.code]
        : 503;
  return json(
    {
      error:
        "This test notification or private status is unavailable. Preserve any original pending request.",
    },
    status,
  );
}
export type OwnerNotificationPage = {
  detail: OwnerNotificationDetail;
  instanceId: string;
  canWrite: boolean;
};
function boundary(request: Request, context: Readonly<RouterContextProvider>) {
  const actor = requireAdmin(context),
    env = context.get(cloudflareContext).env;
  const config = checkoutConfig(request, env);
  if (!enabled(env, "COMMERCE_OWNER_NOTIFICATIONS_UI"))
    throw new Response(null, { status: 404, headers: notificationHeaders });
  return {
    actor,
    env,
    scope: { mode: config.mode, instanceId: config.instanceId },
    origin: config.canonicalOrigin,
    canWrite: enabled(env, "COMMERCE_OWNER_NOTIFICATIONS_WRITES"),
  };
}
function config(b: ReturnType<typeof boundary>): NotificationConfig {
  const secret = Object.getOwnPropertyDescriptor(
    b.env,
    "COMMERCE_NOTIFICATION_LINK_SECRET",
  )?.value;
  if (typeof secret !== "string" || !/^[a-f0-9]{64}$/.test(secret))
    throw new Response(null, { status: 503 });
  return { ...b.scope, canonicalOrigin: b.origin, linkSecret: secret };
}
export async function loadOwnerNotificationPage(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orderId: string,
) {
  try {
    const b = boundary(request, context);
    if (request.method !== "GET") return json({ error: "Use GET." }, 405);
    if (new URL(request.url).search) throw new Response(null, { status: 422 });
    const detail = await readOwnerNotifications(b.env.DB, config(b), orderId);
    if (!detail) throw new Response(null, { status: 404 });
    return json({
      detail,
      instanceId: b.scope.instanceId,
      canWrite: b.canWrite,
    } satisfies OwnerNotificationPage);
  } catch (e) {
    throw reject(e);
  }
}
export async function actOwnerNotificationPage(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orderId: string,
) {
  try {
    const b = boundary(request, context);
    if (request.method !== "POST") return json({ error: "Use POST." }, 405);
    if (new URL(request.url).search) throw new Response(null, { status: 422 });
    const form = await readCommerceForm(request);
    const keys = ["intent", "requestId", "operation", "notificationId"];
    if (
      keys.some((k) => !form.has(k)) ||
      [...form.keys()].some((k) => !keys.includes(k)) ||
      !["apply", "lookup"].includes(form.get("intent")!) ||
      !["prepare", "test_delivered", "test_failed", "revoke"].includes(
        form.get("operation")!,
      )
    )
      throw new Response(null, { status: 422 });
    const input: OwnerNotificationInput = {
      requestId: form.get("requestId")!,
      orderId,
      operation: form.get("operation") as OwnerNotificationInput["operation"],
      notificationId: form.get("notificationId") || null,
    };
    if (form.get("intent") === "lookup")
      return json(
        await lookupOwnerNotificationCommand(b.env.DB, b.scope, b.actor, input),
      );
    if (!b.canWrite) throw new Response(null, { status: 503 });
    const c = config(b);
    const authorize = async () => {
      const current = boundary(request, context),
        fresh = config(current);
      if (
        !current.canWrite ||
        current.actor.email !== b.actor.email ||
        current.actor.sub !== b.actor.sub ||
        fresh.instanceId !== c.instanceId ||
        fresh.canonicalOrigin !== c.canonicalOrigin ||
        fresh.linkSecret !== c.linkSecret
      )
        throw new Response(null, { status: 503 });
    };
    await authorize();
    return json({
      state: "recorded",
      receipt: await applyOwnerNotification(
        b.env.DB,
        c,
        b.actor,
        input,
        Date.now,
        authorize,
      ),
    });
  } catch (e) {
    return reject(e);
  }
}
function publicBoundary(request: Request, env: Env) {
  const c = checkoutConfig(request, env);
  if (!enabled(env, "COMMERCE_ORDER_STATUS_LINKS"))
    throw new Response(null, { status: 404 });
  if (new URL(request.url).search) throw new Response(null, { status: 404 });
  return {
    mode: c.mode,
    instanceId: c.instanceId,
    canonicalOrigin: c.canonicalOrigin,
  };
}
export function loadNotificationStatusLanding(request: Request, env: Env) {
  try {
    publicBoundary(request, env);
    if (request.method !== "GET") return json({ error: "Use GET." }, 405);
    return json({ testOnly: true });
  } catch (e) {
    throw reject(e);
  }
}
export async function actNotificationStatus(request: Request, env: Env) {
  try {
    const scope = publicBoundary(request, env);
    if (request.method !== "POST") return json({ error: "Use POST." }, 405);
    const form = await readCommerceForm(request);
    if (
      form.size !== 1 ||
      !form.has("token") ||
      !/^[a-f0-9]{64}$/.test(form.get("token")!)
    )
      throw new Response(null, { status: 404 });
    const status = await readNotificationStatus(
      env.DB,
      scope,
      form.get("token")!,
    );
    if (!status) throw new Response(null, { status: 404 });
    return json({ testOnly: true, status });
  } catch (e) {
    return reject(e);
  }
}
