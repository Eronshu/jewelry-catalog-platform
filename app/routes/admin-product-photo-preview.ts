import type { Route } from "./+types/admin-product-photo-preview";
import { cloudflareContext } from "../cloudflare-context";
import { requireAdmin } from "../lib/auth/admin-access.server";
import {
  adminPhotoSource,
  parsePhotoId,
} from "../lib/db/admin-product-photos.server";
import { parseProductId } from "../lib/db/admin-products.server";
import { deliverProductImage } from "../lib/images/product-image.server";

export async function loader({ request, context, params }: Route.LoaderArgs) {
  requireAdmin(context);
  const noStore = { "Cache-Control": "private, no-store" };
  if (request.method !== "GET" || new URL(request.url).search)
    return new Response(null, { status: 404, headers: noStore });
  const productId = parseProductId(params.productId);
  const photoId = parsePhotoId(params.photoId);
  const env = context.get(cloudflareContext).env;
  const key = await adminPhotoSource(env.DB, productId, photoId);
  if (!key) return new Response(null, { status: 404, headers: noStore });
  const response = await deliverProductImage(env, productId, key, "thumb");
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  return new Response(response.body, { status: response.status, headers });
}
