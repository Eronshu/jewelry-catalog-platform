import type { RouterContextProvider } from "react-router";
import { cloudflareContext } from "../../cloudflare-context";
import { requireAdmin } from "../auth/admin-access.server";
import { checkoutConfig } from "./checkout-config.server";
import { workspaceHeaders } from "./workspace.server";
import { readCommerceForm } from "./request.server";
import {
  readOwnerStock,
  applyOwnerStock,
  lookupOwnerStockCommand,
  OwnerStockError,
} from "./owner-stock.server";
import type {
  OwnerStockInput,
  OwnerStockDetail,
  OwnerStockOperation,
} from "./owner-stock";
export type OwnerStockPage = {
  detail: OwnerStockDetail;
  instanceId: string;
  canWrite: boolean;
};
export function ownerStockEnabled(env: unknown) {
  return (
    !!env &&
    Object.getOwnPropertyDescriptor(env, "COMMERCE_OWNER_STOCK_UI")?.value ===
      "local-test"
  );
}
function boundary(request: Request, context: Readonly<RouterContextProvider>) {
  const actor = requireAdmin(context),
    env = context.get(cloudflareContext).env;
  const config = checkoutConfig(request, env);
  const scope = { mode: config.mode, instanceId: config.instanceId };
  if (!ownerStockEnabled(env))
    throw new Response("Not Found", { status: 404, headers: workspaceHeaders });
  const canWrite =
    Object.getOwnPropertyDescriptor(env, "COMMERCE_OWNER_STOCK_WRITES")
      ?.value === "local-test";
  return { actor, env, scope, canWrite };
}
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: workspaceHeaders });
function reject(error: unknown) {
  if (error instanceof Response)
    return json({ error: "Stock request not accepted." }, error.status);
  const code = error instanceof OwnerStockError ? error.code : "unavailable";
  const errors = {
    invalid_request: [422, "Review the stock action and quantities."],
    not_found: [404, "Test stock item not found."],
    conflict: [
      409,
      "Stock or this request changed. Keep the original request and ask the developer to review it.",
    ],
    unavailable: [
      503,
      "The result is uncertain. Keep the same request and check it before doing anything else.",
    ],
  } as const;
  return json({ code, error: errors[code][1] }, errors[code][0]);
}
export async function loadOwnerStockPage(
  request: Request,
  context: Readonly<RouterContextProvider>,
  variantId: string,
) {
  const { env, scope, canWrite } = boundary(request, context);
  if (request.method !== "GET")
    return new Response(null, {
      status: 405,
      headers: { ...workspaceHeaders, Allow: "GET" },
    });
  try {
    if (new URL(request.url).search)
      throw new OwnerStockError("invalid_request");
    const detail = await readOwnerStock(env.DB, scope, variantId);
    if (!detail) throw new OwnerStockError("not_found");
    return json({
      detail,
      instanceId: scope.instanceId,
      canWrite,
    } satisfies OwnerStockPage);
  } catch (error) {
    return reject(error);
  }
}
export async function actOwnerStockPage(
  request: Request,
  context: Readonly<RouterContextProvider>,
  variantId: string,
) {
  const initial = boundary(request, context);
  if (request.method !== "POST")
    return new Response(null, {
      status: 405,
      headers: { ...workspaceHeaders, Allow: "POST" },
    });
  try {
    if (new URL(request.url).search)
      throw new OwnerStockError("invalid_request");
    const form = await readCommerceForm(request);
    const keys = [
      "intent",
      "requestId",
      "operation",
      "quantity",
      "variantVersion",
      "onHand",
      "facebookReserved",
      "checkoutReserved",
      "allocated",
      "acknowledge",
    ];
    if (
      keys.some((k) => !form.has(k)) ||
      [...form.keys()].some((k) => !keys.includes(k)) ||
      !["apply", "lookup"].includes(form.get("intent")!) ||
      form.get("acknowledge") !== "true" ||
      !["receive", "fb_reserve", "fb_release", "fb_sale"].includes(
        form.get("operation")!,
      )
    )
      throw new OwnerStockError("invalid_request");
    const integer = (key: string) => {
      const v = form.get(key)!;
      if (
        !(
          key === "variantVersion"
            ? /^[1-9][0-9]{0,15}$/
            : /^(0|[1-9][0-9]{0,6})$/
        ).test(v) ||
        !Number.isSafeInteger(Number(v))
      )
        throw new OwnerStockError("invalid_request");
      return Number(v);
    };
    const input: OwnerStockInput = {
      requestId: form.get("requestId")!,
      variantId,
      operation: form.get("operation") as OwnerStockOperation,
      quantity: integer("quantity"),
      acknowledge: true,
      expected: {
        variantVersion: integer("variantVersion"),
        onHand: integer("onHand"),
        facebookReserved: integer("facebookReserved"),
        checkoutReserved: integer("checkoutReserved"),
        allocated: integer("allocated"),
      },
    };
    if (form.get("intent") === "lookup")
      return json(
        await lookupOwnerStockCommand(
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
    const receipt = await applyOwnerStock(
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
