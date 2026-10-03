import { data } from "react-router";
import type { Route } from "./+types/admin-product-photo";
import { cloudflareContext } from "../cloudflare-context";
import { requireAdmin } from "../lib/auth/admin-access.server";
import { readAdminForm } from "../lib/auth/admin-mutation.server";
import {
  AdminProductError,
  parseProductId,
  parseVersion,
} from "../lib/db/admin-products.server";
import {
  editPhotoAlt,
  noStore,
  PhotoMutationError,
  parsePhotoId,
  removePhoto,
} from "../lib/db/admin-product-photos.server";

export async function action({ request, context, params }: Route.ActionArgs) {
  requireAdmin(context);
  try {
    const form = await readAdminForm(request);
    const productId = parseProductId(params.productId);
    const photoId = parsePhotoId(params.photoId);
    const version = parseVersion(String(form.get("version") ?? ""));
    const intent = form.get("intent");
    const env = context.get(cloudflareContext).env;
    const result =
      intent === "alt"
        ? await editPhotoAlt(
            env.DB,
            productId,
            photoId,
            version,
            String(form.get("altText") ?? ""),
          )
        : intent === "remove"
          ? await removePhoto(env, productId, photoId, version)
          : null;
    if (!result)
      throw new AdminProductError("This action is unavailable.", 400);
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
    console.error("Photo change failed");
    return data(
      { error: "Could not save this photo. Try again." },
      { status: 503, headers: noStore },
    );
  }
}
