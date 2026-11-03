import type { RouterContextProvider } from "react-router";
import { cloudflareContext } from "../../cloudflare-context";
import { requireAdmin } from "../auth/admin-access.server";
import { checkoutConfig } from "./checkout-config.server";
import { workspaceHeaders } from "./workspace.server";
import { readCommerceForm } from "./request.server";
import {
  OwnerAllocationReleaseError,
  readOwnerAllocationRelease,
  applyOwnerAllocationRelease,
  lookupOwnerAllocationReleaseCommand,
} from "./owner-allocation-release.server";
import type {
  OwnerAllocationReleaseDetail,
  OwnerAllocationReleaseInput,
} from "./owner-allocation-release";
export type OwnerAllocationReleasePage = {
  detail: OwnerAllocationReleaseDetail;
  instanceId: string;
  canWrite: boolean;
};
export function ownerAllocationReleaseEnabled(env: unknown) {
  return (
    !!env &&
    Object.getOwnPropertyDescriptor(env, "COMMERCE_OWNER_ALLOCATION_RELEASE_UI")
      ?.value === "local-test"
  );
}
function boundary(request: Request, context: Readonly<RouterContextProvider>) {
  const actor = requireAdmin(context),
    env = context.get(cloudflareContext).env;
  const config = checkoutConfig(request, env);
  if (!ownerAllocationReleaseEnabled(env))
    throw new Response("Not Found", { status: 404, headers: workspaceHeaders });
  return {
    actor,
    env,
    scope: { mode: config.mode, instanceId: config.instanceId },
    canWrite:
      Object.getOwnPropertyDescriptor(
        env,
        "COMMERCE_OWNER_ALLOCATION_RELEASE_WRITES",
      )?.value === "local-test",
  };
}
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: workspaceHeaders });
function reject(error: unknown) {
  if (error instanceof Response)
    return json({ error: "Stock release not accepted." }, error.status);
  const code =
    error instanceof OwnerAllocationReleaseError ? error.code : "unavailable";
  const messages = {
    invalid_request: [422, "Review the refunded order and stock confirmation."],
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
export async function loadOwnerAllocationReleasePage(
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
      throw new OwnerAllocationReleaseError("invalid_request");
    const detail = await readOwnerAllocationRelease(env.DB, scope, orderId);
    if (!detail) throw new OwnerAllocationReleaseError("not_found");
    return json({
      detail,
      instanceId: scope.instanceId,
      canWrite,
    } satisfies OwnerAllocationReleasePage);
  } catch (error) {
    throw reject(error);
  }
}
export async function actOwnerAllocationReleasePage(
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
      throw new OwnerAllocationReleaseError("invalid_request");
    const form = await readCommerceForm(request);
    const keys = [
      "intent",
      "requestId",
      "expectedVersion",
      "expectedStockHash",
      "acknowledge",
    ];
    if (
      keys.some((k) => !form.has(k)) ||
      [...form.keys()].some((k) => !keys.includes(k)) ||
      !["apply", "lookup"].includes(form.get("intent")!) ||
      form.get("acknowledge") !== "true" ||
      !/^[1-9][0-9]{0,15}$/.test(form.get("expectedVersion")!) ||
      !Number.isSafeInteger(Number(form.get("expectedVersion"))) ||
      !/^[a-f0-9]{64}$/.test(form.get("expectedStockHash")!)
    )
      throw new OwnerAllocationReleaseError("invalid_request");
    const input: OwnerAllocationReleaseInput = {
      requestId: form.get("requestId")!,
      orderId,
      expectedVersion: Number(form.get("expectedVersion")),
      expectedStockHash: form.get("expectedStockHash")!,
      acknowledge: true,
    };
    if (form.get("intent") === "lookup")
      return json(
        await lookupOwnerAllocationReleaseCommand(
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
    const receipt = await applyOwnerAllocationRelease(
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
