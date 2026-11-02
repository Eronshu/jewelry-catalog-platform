import type { RouterContextProvider } from "react-router";
import { cloudflareContext } from "../../cloudflare-context";
import { requireAdmin } from "../auth/admin-access.server";
import { checkoutConfig } from "./checkout-config.server";
import { stripeRuntimeConfig } from "./stripe-runtime-config.server";
import { paypalRuntimeConfig } from "./paypal-runtime-config.server";
import type { StripeSandboxFetch } from "./stripe-sandbox.server";
import { workspaceHeaders } from "./workspace.server";
import { readCommerceForm } from "./request.server";
import {
  OwnerRefundError,
  readOwnerRefund,
  startOwnerStripeRefund,
  reconcileOwnerStripeRefund,
  startOwnerPayPalRefund,
  reconcileOwnerPayPalRefund,
  lookupOwnerRefundCommand,
} from "./owner-refund.server";
import type { OwnerRefundDetail, OwnerRefundInput } from "./owner-refund";

export type OwnerRefundPage = {
  detail: OwnerRefundDetail;
  instanceId: string;
  canWrite: boolean;
  canQuery: boolean;
};
export function ownerRefundEnabled(env: unknown) {
  return (
    !!env &&
    Object.getOwnPropertyDescriptor(env, "COMMERCE_OWNER_REFUND_UI")?.value ===
      "local-test"
  );
}
function boundary(request: Request, context: Readonly<RouterContextProvider>) {
  const actor = requireAdmin(context);
  const env = context.get(cloudflareContext).env;
  const config = checkoutConfig(request, env);
  if (!ownerRefundEnabled(env))
    throw new Response("Not Found", { status: 404, headers: workspaceHeaders });
  return {
    actor,
    env,
    scope: { mode: config.mode, instanceId: config.instanceId },
    canQuery:
      Object.getOwnPropertyDescriptor(env, "COMMERCE_OWNER_REFUND_QUERIES")
        ?.value === "local-test",
    canWrite:
      Object.getOwnPropertyDescriptor(env, "COMMERCE_OWNER_REFUND_WRITES")
        ?.value === "local-test",
  };
}
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: workspaceHeaders });
function reject(error: unknown) {
  if (error instanceof Response)
    return json({ error: "Refund request not accepted." }, error.status);
  const code = error instanceof OwnerRefundError ? error.code : "unavailable";
  const errors = {
    invalid_request: [422, "Review the order and refund action."],
    not_found: [404, "Test order not found."],
    conflict: [
      409,
      "Order or payment changed. Preserve this request and ask the developer to review it.",
    ],
    unavailable: [
      503,
      "The result is uncertain. Check the original request before another action.",
    ],
  } as const;
  return json({ code, error: errors[code][1] }, errors[code][0]);
}
export async function loadOwnerRefundPage(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orderId: string,
) {
  const { env, scope, canWrite, canQuery } = boundary(request, context);
  if (request.method !== "GET")
    return new Response(null, {
      status: 405,
      headers: { ...workspaceHeaders, Allow: "GET" },
    });
  try {
    if (new URL(request.url).search)
      throw new OwnerRefundError("invalid_request");
    const detail = await readOwnerRefund(env.DB, scope, orderId);
    if (!detail) throw new OwnerRefundError("not_found");
    return json({
      detail,
      instanceId: scope.instanceId,
      canWrite,
      canQuery,
    } satisfies OwnerRefundPage);
  } catch (error) {
    throw reject(error);
  }
}
export async function actOwnerRefundPage(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orderId: string,
  fetcher: StripeSandboxFetch = (url, init) => fetch(url, init),
) {
  const initial = boundary(request, context);
  if (request.method !== "POST")
    return new Response(null, {
      status: 405,
      headers: { ...workspaceHeaders, Allow: "POST" },
    });
  try {
    if (new URL(request.url).search)
      throw new OwnerRefundError("invalid_request");
    const form = await readCommerceForm(request);
    const keys = ["intent", "requestId", "expectedVersion", "acknowledge"];
    if (
      keys.some((k) => !form.has(k)) ||
      [...form.keys()].some((k) => !keys.includes(k)) ||
      !["start", "query", "lookup"].includes(form.get("intent")!) ||
      form.get("acknowledge") !== "true" ||
      !/^[1-9][0-9]{0,15}$/.test(form.get("expectedVersion")!) ||
      !Number.isSafeInteger(Number(form.get("expectedVersion")))
    )
      throw new OwnerRefundError("invalid_request");
    const input: OwnerRefundInput = {
      requestId: form.get("requestId")!,
      orderId,
      expectedVersion: Number(form.get("expectedVersion")),
      acknowledge: true,
    };
    if (form.get("intent") === "lookup")
      return json(
        await lookupOwnerRefundCommand(
          initial.env.DB,
          initial.scope,
          initial.actor,
          input,
        ),
      );
    const isStart = form.get("intent") === "start";
    if (isStart ? !initial.canWrite : !initial.canQuery)
      throw new Response(null, { status: 503 });
    // Select the original order's provider on the server, never from form data.
    // With neither explicit opt-in, deny before even reading refund history.
    if (
      Object.getOwnPropertyDescriptor(initial.env, "COMMERCE_STRIPE_SANDBOX")
        ?.value !== "local-test" &&
      Object.getOwnPropertyDescriptor(initial.env, "COMMERCE_PAYPAL_SANDBOX")
        ?.value !== "local-test"
    )
      throw new Response(null, { status: 503 });
    const detail = await readOwnerRefund(
      initial.env.DB,
      initial.scope,
      orderId,
    );
    if (!detail) throw new OwnerRefundError("not_found");
    const authorizeActor = () => {
      const current = boundary(request, context);
      if (
        (isStart ? !current.canWrite : !current.canQuery) ||
        current.actor.email !== initial.actor.email ||
        current.actor.sub !== initial.actor.sub ||
        current.scope.instanceId !== initial.scope.instanceId
      )
        throw new Response(null, { status: 503 });
      return current;
    };
    let receipt;
    if (detail.provider === "stripe") {
      const config = stripeRuntimeConfig(request, initial.env);
      if (!config) throw new Response(null, { status: 503 });
      const authorize = async () => {
        const current = authorizeActor();
        const fresh = stripeRuntimeConfig(request, current.env);
        if (
          !fresh ||
          fresh.provider.expectedAccountId !==
            config.provider.expectedAccountId ||
          fresh.provider.testSecretKey !== config.provider.testSecretKey ||
          fresh.provider.canonicalOrigin !== config.provider.canonicalOrigin ||
          fresh.provider.instanceId !== config.provider.instanceId
        )
          throw new Response(null, { status: 503 });
      };
      await authorize();
      receipt = await (
        isStart ? startOwnerStripeRefund : reconcileOwnerStripeRefund
      )(
        initial.env.DB,
        initial.scope,
        initial.actor,
        input,
        config.provider,
        fetcher,
        Date.now,
        authorize,
      );
    } else if (detail.provider === "paypal") {
      const config = paypalRuntimeConfig(request, initial.env);
      if (!config) throw new Response(null, { status: 503 });
      const authorize = async () => {
        const current = authorizeActor();
        const fresh = paypalRuntimeConfig(request, current.env);
        if (
          !fresh ||
          fresh.provider.expectedMerchantId !==
            config.provider.expectedMerchantId ||
          fresh.provider.clientId !== config.provider.clientId ||
          fresh.provider.clientSecret !== config.provider.clientSecret ||
          fresh.provider.canonicalOrigin !== config.provider.canonicalOrigin ||
          fresh.provider.instanceId !== config.provider.instanceId
        )
          throw new Response(null, { status: 503 });
      };
      await authorize();
      receipt = await (
        isStart ? startOwnerPayPalRefund : reconcileOwnerPayPalRefund
      )(
        initial.env.DB,
        initial.scope,
        initial.actor,
        input,
        config.provider,
        fetcher,
        Date.now,
        authorize,
      );
    } else throw new OwnerRefundError("conflict");
    return json({ state: "recorded", receipt });
  } catch (error) {
    return reject(error);
  }
}
