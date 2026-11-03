import type { RouterContextProvider } from "react-router";
import { cloudflareContext } from "../../cloudflare-context";
import { requireAdmin } from "../auth/admin-access.server";
import { checkoutConfig } from "./checkout-config.server";
import { workspaceHeaders } from "./workspace.server";
import { readCommerceForm } from "./request.server";
import {
  OwnerReturnError,
  readOwnerReturn,
  applyOwnerReturn,
  lookupOwnerReturnCommand,
} from "./owner-return.server";
import type { OwnerReturnDetail, OwnerReturnInput } from "./owner-return";
export type OwnerReturnPage = {
  detail: OwnerReturnDetail;
  instanceId: string;
  canWrite: boolean;
};
export function ownerReturnEnabled(env: unknown) {
  return (
    !!env &&
    Object.getOwnPropertyDescriptor(env, "COMMERCE_OWNER_RETURN_UI")?.value ===
      "local-test"
  );
}
function boundary(request: Request, context: Readonly<RouterContextProvider>) {
  const actor = requireAdmin(context),
    env = context.get(cloudflareContext).env;
  const config = checkoutConfig(request, env);
  if (!ownerReturnEnabled(env))
    throw new Response("Not Found", { status: 404, headers: workspaceHeaders });
  return {
    actor,
    env,
    scope: { mode: config.mode, instanceId: config.instanceId },
    canWrite:
      Object.getOwnPropertyDescriptor(env, "COMMERCE_OWNER_RETURN_WRITES")
        ?.value === "local-test",
  };
}
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: workspaceHeaders });
function reject(error: unknown) {
  if (error instanceof Response)
    return json({ error: "Return action not accepted." }, error.status);
  const code = error instanceof OwnerReturnError ? error.code : "unavailable";
  const messages = {
    invalid_request: [422, "Review the order and inspection action."],
    not_found: [404, "Test order not found."],
    conflict: [
      409,
      "The order or stock changed. Preserve the original request and reload before another action.",
    ],
    unavailable: [
      503,
      "The result is unconfirmed. Check the original request before another action.",
    ],
  } as const;
  return json({ code, error: messages[code][1] }, messages[code][0]);
}
export async function loadOwnerReturnPage(
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
      throw new OwnerReturnError("invalid_request");
    const detail = await readOwnerReturn(env.DB, scope, orderId);
    if (!detail) throw new OwnerReturnError("not_found");
    return json({
      detail,
      instanceId: scope.instanceId,
      canWrite,
    } satisfies OwnerReturnPage);
  } catch (error) {
    throw reject(error);
  }
}
export async function actOwnerReturnPage(
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
      throw new OwnerReturnError("invalid_request");
    const form = await readCommerceForm(request);
    const keys = [
      "intent",
      "requestId",
      "operation",
      "expectedVersion",
      "expectedStockHash",
      "acknowledge",
    ];
    if (
      keys.some((k) => !form.has(k)) ||
      [...form.keys()].some((k) => !keys.includes(k)) ||
      !["apply", "lookup"].includes(form.get("intent")!) ||
      !["inspect_sellable", "inspect_unsuitable", "restock"].includes(
        form.get("operation")!,
      ) ||
      form.get("acknowledge") !== "true" ||
      !/^[1-9][0-9]{0,15}$/.test(form.get("expectedVersion")!) ||
      !Number.isSafeInteger(Number(form.get("expectedVersion"))) ||
      !/^[a-f0-9]{64}$/.test(form.get("expectedStockHash")!)
    )
      throw new OwnerReturnError("invalid_request");
    const input: OwnerReturnInput = {
      requestId: form.get("requestId")!,
      orderId,
      operation: form.get("operation")! as OwnerReturnInput["operation"],
      expectedVersion: Number(form.get("expectedVersion")),
      expectedStockHash: form.get("expectedStockHash")!,
      acknowledge: true,
    };
    if (form.get("intent") === "lookup")
      return json(
        await lookupOwnerReturnCommand(
          initial.env.DB,
          initial.scope,
          initial.actor,
          input,
        ),
      );
    if (!initial.canWrite) throw new Response(null, { status: 503 });
    const authorize = async () => {
      const current = boundary(request, context);
      if (
        !current.canWrite ||
        current.actor.email !== initial.actor.email ||
        current.actor.sub !== initial.actor.sub ||
        current.scope.instanceId !== initial.scope.instanceId
      )
        throw new Response(null, { status: 503 });
    };
    await authorize();
    const receipt = await applyOwnerReturn(
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
