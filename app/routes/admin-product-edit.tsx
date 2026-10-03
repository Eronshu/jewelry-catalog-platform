import { data, redirect, useBeforeUnload, useBlocker } from "react-router";
import type { ShouldRevalidateFunctionArgs } from "react-router";
import { useCallback, useEffect, useRef, useState } from "react";

import type { Route } from "./+types/admin-product-edit";
import { AdminShell } from "../components/admin/admin-shell";
import { ProductForm } from "../components/admin/product-form";
import { ProductPhotos } from "../components/admin/product-photos";
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
import {
  readAdminPhotoSnapshot,
  type AdminPhoto,
} from "../lib/db/admin-product-photos.server";

export function shouldRevalidate({
  formAction,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  if (formAction && /\/admin\/products\/\d+\/photos(?:\/|$)/.test(formAction))
    return false;
  return defaultShouldRevalidate;
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  requireAdmin(context);
  const db = context.get(cloudflareContext).env.DB;
  const id = parseProductId(params.productId);
  const product = await getAdminProduct(db, id);
  if (!product) throw new Response("Product not found", { status: 404 });
  const photoSnapshot = await readAdminPhotoSnapshot(db, id);
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
    photos: photoSnapshot.photos,
    businessVersion: photoSnapshot.businessVersion,
    success: new URL(request.url).searchParams.get("message") === "saved",
    creationMessage: new URL(request.url).searchParams.get("message"),
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
    <EditProductContent
      key={`${loaderData.product.id}:${loaderData.success ? loaderData.product.updatedAt : "editing"}`}
      loaderData={loaderData}
      actionData={actionData}
    />
  );
}

function EditProductContent({
  loaderData,
  actionData,
}: Pick<Route.ComponentProps, "loaderData" | "actionData">) {
  const [version, setVersion] = useState(loaderData.product.updatedAt);
  const [photos, setPhotos] = useState(loaderData.photos ?? []);
  const businessDirty = useRef(false);
  const uploadingPhoto = useRef(false);
  const submittingProduct = useRef(false);
  const leavingPage = useRef(false);
  const shouldStopQueuedUploads = useCallback(() => leavingPage.current, []);
  const onDirtyChange = useCallback((dirty: boolean) => {
    businessDirty.current = dirty;
  }, []);
  const onSubmittingChange = useCallback((submitting: boolean) => {
    submittingProduct.current = submitting;
  }, []);
  const onUploadActiveChange = useCallback((active: boolean) => {
    uploadingPhoto.current = active;
  }, []);
  const confirmBeforeSubmit = useCallback(
    () =>
      !uploadingPhoto.current ||
      window.confirm(
        "Save product details while a photo is uploading? Leaving or reloading this editor may hide the upload result. Check saved photos afterward.",
      ),
    [],
  );
  const shouldWarn = () =>
    !submittingProduct.current &&
    (businessDirty.current ||
      Boolean(actionData?.error) ||
      uploadingPhoto.current);
  const blocker = useBlocker(shouldWarn);
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    const dirty = businessDirty.current || Boolean(actionData?.error);
    const uploading = uploadingPhoto.current;
    const message =
      dirty && uploading
        ? "Leave while a photo is uploading and product changes are unsaved? The photo may still finish."
        : uploading
          ? "Leave while a photo is uploading? The photo may still finish."
          : "Leave without saving your changes?";
    if (window.confirm(message)) {
      leavingPage.current = true;
      blocker.proceed();
    } else blocker.reset();
  }, [blocker, actionData]);
  useBeforeUnload((event) => {
    if (shouldWarn()) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  const onPhotoVersion = (
    newVersion: number,
    businessVersion: number,
    savedPhotos: AdminPhoto[],
  ) => {
    if (businessVersion === loaderData.businessVersion) setVersion(newVersion);
    setPhotos(savedPhotos);
  };
  return (
    <AdminShell>
      <div className="admin-page-heading">
        <div>
          <h1>{loaderData.product.name}</h1>
          <p>Status: {loaderData.product.status}</p>
          <p>Photos: {photos.length}</p>
        </div>
      </div>
      {loaderData.success && (
        <p className="admin-success" role="status">
          Product saved.
        </p>
      )}
      {loaderData.creationMessage === "created" && (
        <p className="admin-success" role="status">
          Draft saved. Review saved photos here before publishing.
        </p>
      )}
      {loaderData.creationMessage === "recovered" && (
        <p className="admin-note" role="status">
          Draft found after reload. Browser-selected files were lost; inspect
          saved photos before selecting any again.
        </p>
      )}
      <ProductForm
        key={loaderData.product.id}
        categories={loaderData.categories}
        initial={loaderData.fields}
        feedback={actionData}
        version={actionData?.version ?? version}
        status={loaderData.product.status}
        photoCount={photos.length}
        onDirtyChange={onDirtyChange}
        onSubmittingChange={onSubmittingChange}
        confirmBeforeSubmit={confirmBeforeSubmit}
      />
      <ProductPhotos
        productId={loaderData.product.id}
        status={loaderData.product.status}
        initialPhotos={photos}
        version={version}
        businessVersion={loaderData.businessVersion}
        onVersion={onPhotoVersion}
        onUploadActiveChange={onUploadActiveChange}
        shouldStopQueuedUploads={shouldStopQueuedUploads}
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
