import { data, redirect } from "react-router";

import type { Route } from "./+types/admin-product-new";
import { AdminShell } from "../components/admin/admin-shell";
import { ProductForm } from "../components/admin/product-form";
import { cloudflareContext } from "../cloudflare-context";
import { requireAdmin } from "../lib/auth/admin-access.server";
import { readAdminForm } from "../lib/auth/admin-mutation.server";
import {
  AdminProductError,
  createDraft,
  fieldsFromForm,
} from "../lib/db/admin-products.server";
import { listActiveCategories } from "../lib/db/categories.server";

export async function loader({ context }: Route.LoaderArgs) {
  requireAdmin(context);
  const categories = await listActiveCategories(
    context.get(cloudflareContext).env.DB,
  );
  return { categories, requestKey: crypto.randomUUID() };
}

export async function action({ request, context }: Route.ActionArgs) {
  requireAdmin(context);
  let fields;
  let requestKey;
  try {
    const form = await readAdminForm(request);
    fields = fieldsFromForm(form);
    requestKey = String(form.get("requestKey") ?? "");
    if (form.get("intent") !== "create")
      throw new AdminProductError("This action is unavailable.", 400);
    const id = await createDraft(
      context.get(cloudflareContext).env.DB,
      fields,
      requestKey,
    );
    return redirect(`/admin/products/${id}/edit`);
  } catch (error) {
    if (error instanceof AdminProductError)
      return data(
        { error: error.message, fieldErrors: error.fields, fields, requestKey },
        { status: error.status },
      );
    if (error instanceof Response || !fields) throw error;
    console.error("Admin product create operation failed");
    return data(
      {
        error:
          "Could not save this product. Your entries are still here. Try again.",
        fields,
        requestKey,
      },
      { status: 503, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}

export function meta() {
  return [
    { title: "Add product | Catalog admin" },
    { name: "robots", content: "noindex" },
  ];
}

export default function NewProduct({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  return (
    <AdminShell>
      <div className="admin-page-heading">
        <div>
          <h1>Add product</h1>
          <p>Save a Draft to get started.</p>
        </div>
      </div>
      <ProductForm
        categories={loaderData.categories}
        requestKey={actionData?.requestKey ?? loaderData.requestKey}
        feedback={actionData}
      />
    </AdminShell>
  );
}

export function ErrorBoundary() {
  return (
    <AdminShell>
      <div className="admin-alert" role="alert">
        <h1>Product form unavailable</h1>
        <p>Please try again later.</p>
      </div>
    </AdminShell>
  );
}
