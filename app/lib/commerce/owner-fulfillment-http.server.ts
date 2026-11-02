import type { RouterContextProvider } from "react-router";
import { cloudflareContext } from "../../cloudflare-context";
import { requireAdmin } from "../auth/admin-access.server";
import { checkoutConfig } from "./checkout-config.server";
import { workspaceHeaders } from "./workspace.server";
import { readCommerceForm } from "./request.server";
import {
  OwnerFulfillmentError,
  readOwnerFulfillment,
  applyOwnerFulfillment,
  lookupOwnerFulfillmentCommand,
} from "./owner-fulfillment.server";
import type {
  OwnerFulfillmentDetail,
  OwnerFulfillmentInput,
  OwnerFulfillmentOperation,
} from "./owner-fulfillment";

export type OwnerFulfillmentPage = {
  detail: OwnerFulfillmentDetail;
  instanceId: string;
  canWrite: boolean;
};
export function ownerFulfillmentEnabled(env: unknown) {
  return (
    !!env &&
    Object.getOwnPropertyDescriptor(env, "COMMERCE_OWNER_FULFILLMENT_UI")
      ?.value === "local-test"
  );
}
function boundary(request: Request, context: Readonly<RouterContextProvider>) {
  const actor = requireAdmin(context);
  const env = context.get(cloudflareContext).env;
  const config = checkoutConfig(request, env);
  if (!ownerFulfillmentEnabled(env))
    throw new Response("Not Found", { status: 404, headers: workspaceHeaders });
  return {
    actor,
    env,
    scope: { mode: config.mode, instanceId: config.instanceId },
    canWrite:
      Object.getOwnPropertyDescriptor(env, "COMMERCE_OWNER_FULFILLMENT_WRITES")
        ?.value === "local-test",
  };
}
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: workspaceHeaders });
function reject(error: unknown) {
  if (error instanceof Response)
    return json({ error: "Fulfillment request not accepted." }, error.status);
  const code =
    error instanceof OwnerFulfillmentError ? error.code : "unavailable";
  const errors = {
    invalid_request: [422, "Review the order and fulfillment action."],
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
export async function loadOwnerFulfillmentPage(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orderId: string,
) {
  const { env, scope, canWrite } = boundary(request, context);
  if (request.method !== "GET")
    return new Response(null, {
      status: 405,
      headers: { ...workspaceHeaders, Allow: "GET" },
    });
  try {
    if (new URL(request.url).search)
      throw new OwnerFulfillmentError("invalid_request");
    const detail = await readOwnerFulfillment(env.DB, scope, orderId);
    if (!detail) throw new OwnerFulfillmentError("not_found");
    return json({
      detail,
      instanceId: scope.instanceId,
      canWrite,
    } satisfies OwnerFulfillmentPage);
  } catch (error) {
    throw reject(error);
  }
}
export async function actOwnerFulfillmentPage(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orderId: string,
) {
  const initial = boundary(request, context);
  if (request.method !== "POST")
    return new Response(null, {
      status: 405,
      headers: { ...workspaceHeaders, Allow: "POST" },
    });
  try {
    if (new URL(request.url).search)
      throw new OwnerFulfillmentError("invalid_request");
    const form = await readCommerceForm(request);
    const keys = [
      "intent",
      "requestId",
      "operation",
      "expectedVersion",
      "acknowledge",
    ];
    if (
      keys.some((k) => !form.has(k)) ||
      [...form.keys()].some((k) => !keys.includes(k)) ||
      !["apply", "lookup"].includes(form.get("intent")!) ||
      form.get("acknowledge") !== "true" ||
      !["pack", "collect", "deliver", "ship"].includes(
        form.get("operation")!,
      ) ||
      !/^[1-9][0-9]{0,15}$/.test(form.get("expectedVersion")!) ||
      !Number.isSafeInteger(Number(form.get("expectedVersion")))
    )
      throw new OwnerFulfillmentError("invalid_request");
    const input: OwnerFulfillmentInput = {
      requestId: form.get("requestId")!,
      orderId,
      operation: form.get("operation") as OwnerFulfillmentOperation,
      expectedVersion: Number(form.get("expectedVersion")),
      acknowledge: true,
    };
    if (form.get("intent") === "lookup")
      return json(
        await lookupOwnerFulfillmentCommand(
          initial.env.DB,
          initial.scope,
          initial.actor,
          input,
        ),
      );
    const authorize = async () => {
      const current = boundary(request, context);
      if (!current.canWrite) throw new Response(null, { status: 503 });
    };
    await authorize();
    const receipt = await applyOwnerFulfillment(
      initial.env.DB,
      initial.scope,
      initial.actor,
      input,
      Date.now,
      authorize,
    );
    return json({ state: "recorded", receipt });
  } catch (error) {
    return reject(error);
  }
}
