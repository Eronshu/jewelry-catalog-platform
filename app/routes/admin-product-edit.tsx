import { data, redirect } from "react-router";

import type { Route } from "./+types/admin-product-edit";
import { AdminShell } from "../components/admin/admin-shell";
import { ProductForm } from "../components/admin/product-form";
import { cloudflareContext } from "../cloudflare-context";
import { requireAdmin } from "../lib/auth/admin-access.server";
import { readAdminForm } from "../lib/auth/admin-mutation.server";
import {
  AdminProductError,
  changeProduct,
  fieldsFromForm,
  fieldsFromProduct,
  getAdminProduct,
  parseProductId,
  parseVersion,
  type ProductIntent,
} from "../lib/db/admin-products.server";
import { listActiveCategories } from "../lib/db/categories.server";
import type { Category } from "../lib/db/catalog-types";

export async function loader({ params, context, request }: Route.LoaderArgs) {
  requireAdmin(context);
  const db = context.get(cloudflareContext).env.DB;
  const id = parseProductId(params.productId);
  const product = await getAdminProduct(db, id);
  if (!product) throw new Response("Product not found", { status: 404 });
  const photoCount = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM product_images WHERE product_id = ?",
    )
    .bind(id)
    .first<{ count: number }>();
  const categories = await listActiveCategories(db);
  if (!categories.some((category) => category.id === product.categoryId)) {
    const category = await db
      .prepare(
        "SELECT id, name, slug, sort_order, is_active FROM categories WHERE id = ?",
      )
      .bind(product.categoryId)
      .first<{
        id: number;
        name: string;
        slug: string;
        sort_order: number;
        is_active: number;
      }>();
    if (category)
      categories.push({
        id: category.id,
        name: category.name,
        slug: category.slug,
        sortOrder: category.sort_order,
        isActive: false,
      } satisfies Category);
  }
  return {
    product,
    categories,
    fields: fieldsFromProduct(product),
    photoCount: photoCount?.count ?? 0,
    success: new URL(request.url).searchParams.get("message") === "saved",
  };
}

export async function action({ params, request, context }: Route.ActionArgs) {
  requireAdmin(context);
  let fields;
  let version;
  try {
    const form = await readAdminForm(request);
    const intent = String(form.get("intent") ?? "");
    fields = fieldsFromForm(form);
    if (
      ![
        "save",
        "publish",
        "mark-sold",
        "mark-available",
        "hide",
        "draft",
        "archive",
        "restore",
      ].includes(intent)
    )
      throw new AdminProductError("This action is unavailable.", 400);
    const id = parseProductId(params.productId);
    version = parseVersion(String(form.get("version") ?? ""));
    await changeProduct(
      context.get(cloudflareContext).env,
      id,
      version,
      intent as ProductIntent,
      intent === "restore" ? undefined : fields,
    );
    return redirect(`/admin/products/${id}/edit?message=saved`);
  } catch (error) {
    if (error instanceof AdminProductError)
      return data(
        { error: error.message, fieldErrors: error.fields, fields, version },
        { status: error.status },
      );
    if (error instanceof Response || !fields || version === undefined)
      throw error;
    console.error("Admin product edit operation failed");
    return data(
      {
        error:
          "Could not save this product. Your entries are still here. Try again.",
        fields,
        version,
      },
      { status: 503, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}

export function meta() {
  return [
    { title: "Edit product | Catalog admin" },
    { name: "robots", content: "noindex" },
  ];
}

export default function EditProduct({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  return (
    <AdminShell>
      <div className="admin-page-heading">
        <div>
          <h1>{loaderData.product.name}</h1>
          <p>Status: {loaderData.product.status}</p>
          <p>Photos: {loaderData.photoCount}</p>
        </div>
      </div>
      {loaderData.success && (
        <p className="admin-success" role="status">
          Product saved.
        </p>
      )}
      <ProductForm
        key={loaderData.product.updatedAt}
        categories={loaderData.categories}
        initial={loaderData.fields}
        feedback={actionData}
        version={actionData?.version ?? loaderData.product.updatedAt}
        status={loaderData.product.status}
        photoCount={loaderData.photoCount}
      />
    </AdminShell>
  );
}

export function ErrorBoundary() {
  return (
    <AdminShell>
      <div className="admin-alert" role="alert">
        <h1>Product unavailable</h1>
        <p>Please return to Products and try again.</p>
      </div>
    </AdminShell>
  );
}
