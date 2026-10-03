import { data } from "react-router";
import type { Route } from "./+types/admin-product-photo-upload";
import { cloudflareContext } from "../cloudflare-context";
import { requireAdmin } from "../lib/auth/admin-access.server";
import {
  AdminProductError,
  parseProductId,
} from "../lib/db/admin-products.server";
import {
  noStore,
  PhotoMutationError,
  uploadPhoto,
} from "../lib/db/admin-product-photos.server";

export async function action({ request, params, context }: Route.ActionArgs) {
  requireAdmin(context);
  try {
    if (
      request.method !== "POST" ||
      request.headers.get("Origin") !== new URL(request.url).origin
    )
      throw new AdminProductError("Refresh this page and try again.", 403);
    if (
      request.headers.get("Sec-Fetch-Site") &&
      request.headers.get("Sec-Fetch-Site") !== "same-origin"
    )
      throw new AdminProductError("Refresh this page and try again.", 403);
    const result = await uploadPhoto(
      context.get(cloudflareContext).env,
      parseProductId(params.productId),
      request,
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
    console.error("Photo upload failed");
    return data(
      { error: "Upload failed. Retry this photo." },
      { status: 503, headers: noStore },
    );
  }
}
