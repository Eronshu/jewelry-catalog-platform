import { data } from "react-router";
import type { Route } from "./+types/admin-product-create";
import { cloudflareContext } from "../cloudflare-context";
import { requireAdmin } from "../lib/auth/admin-access.server";
import { readAdminForm } from "../lib/auth/admin-mutation.server";
import {
  AdminProductError,
  createDraft,
  fieldsFromForm,
  findCreationRequest,
} from "../lib/db/admin-products.server";

const noStore = { "Cache-Control": "private, no-store" };

export async function action({ request, context }: Route.ActionArgs) {
  requireAdmin(context);
  try {
    const form = await readAdminForm(request);
    const key = String(form.get("requestKey") ?? "");
    const db = context.get(cloudflareContext).env.DB;
    if (form.get("intent") === "lookup") {
      return data(
        { product: await findCreationRequest(db, key) },
        { headers: noStore },
      );
    }
    if (form.get("intent") !== "create")
      throw new AdminProductError("This action is unavailable.", 400);
    const fields = fieldsFromForm(form);
    const id = await createDraft(db, fields, key);
    const product = await findCreationRequest(db, key);
    if (!product || product.id !== id || product.status !== "draft")
      throw new AdminProductError(
        "This Draft changed. Open Products to review it.",
        409,
      );
    return data({ product }, { headers: noStore });
  } catch (error) {
    if (error instanceof AdminProductError)
      return data(
        { error: error.message, fieldErrors: error.fields },
        { status: error.status, headers: noStore },
      );
    console.error("Admin product create request failed");
    return data(
      { error: "Could not confirm the Draft. Retry saving these details." },
      { status: 503, headers: noStore },
    );
  }
}
