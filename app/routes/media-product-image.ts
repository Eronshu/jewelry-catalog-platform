import type { Route } from "./+types/media-product-image";
import { cloudflareContext } from "../cloudflare-context";
import { getPublicImageSource } from "../lib/db/products.server";
import { isImageProfile } from "../lib/images/image-profiles";
import { deliverProductImage } from "../lib/images/product-image.server";

function positiveId(value: string | undefined): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function errorResponse(status: number): Response {
  return new Response(null, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const productId = positiveId(params.productId);
  const imageId = positiveId(params.imageId);
  if (
    request.method !== "GET" ||
    productId === null ||
    imageId === null ||
    !params.profile ||
    !isImageProfile(params.profile) ||
    new URL(request.url).search !== ""
  ) {
    return errorResponse(404);
  }

  const { env } = context.get(cloudflareContext);
  let source;
  try {
    source = await getPublicImageSource(env.DB, productId, imageId);
  } catch (error) {
    console.error("Product image D1 read failed", error);
    return errorResponse(503);
  }
  if (source === null) return errorResponse(404);
  return deliverProductImage(env, productId, source.r2Key, params.profile);
}
