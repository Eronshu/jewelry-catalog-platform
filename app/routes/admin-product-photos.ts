import { data } from "react-router";
import type { Route } from "./+types/admin-product-photos";
import { cloudflareContext } from "../cloudflare-context";
import { requireAdmin } from "../lib/auth/admin-access.server";
import { readAdminForm } from "../lib/auth/admin-mutation.server";
import {
  AdminProductError,
  parseProductId,
  parseVersion,
} from "../lib/db/admin-products.server";
import {
  readAdminPhotoSnapshot,
  noStore,
  PhotoMutationError,
  reorderPhotos,
} from "../lib/db/admin-product-photos.server";

export async function loader({ context, params }: Route.LoaderArgs) {
  requireAdmin(context);
  try {
    const productId = parseProductId(params.productId);
    return data(
      await readAdminPhotoSnapshot(
        context.get(cloudflareContext).env.DB,
        productId,
      ),
      { headers: noStore },
    );
  } catch (error) {
    if (error instanceof AdminProductError)
      return data(
        {
          error: error.message,
          code:
            error instanceof PhotoMutationError
              ? error.code
              : error.status === 409
                ? "photo_conflict"
                : "error",
        },
        { status: error.status, headers: noStore },
      );
    throw error;
  }
}
export async function action({ request, context, params }: Route.ActionArgs) {
  requireAdmin(context);
  try {
    const form = await readAdminForm(request);
    if (form.get("intent") !== "reorder")
      throw new AdminProductError("This action is unavailable.", 400);
    const value = String(form.get("order") ?? "");
    const ids = value.split(",").map((part) => Number(part));
    const result = await reorderPhotos(
      context.get(cloudflareContext).env.DB,
      parseProductId(params.productId),
      parseVersion(String(form.get("version") ?? "")),
      ids,
    );
    return data(result, { headers: noStore });
  } catch (error) {
    if (error instanceof AdminProductError)
      return data(
        {
          error: error.message,
          code:
            error instanceof PhotoMutationError
              ? error.code
              : error.status === 409
                ? "photo_conflict"
                : "error",
        },
        { status: error.status, headers: noStore },
      );
    console.error("Photo order failed");
    return data(
      { error: "Could not change photo order. Try again." },
      { status: 503, headers: noStore },
    );
  }
}
