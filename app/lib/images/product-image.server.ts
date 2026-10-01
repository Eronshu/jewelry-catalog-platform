import { imageProfiles, type ImageProfile } from "./image-profiles";

const publicCache = "public, max-age=86400, stale-while-revalidate=604800";
const noStore = "private, no-store";
const acceptedTypes = new Map([
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
]);

export function imageKeyContentType(
  key: string,
  productId: number,
): string | null {
  // The image ID is deliberately absent from the R2 key. The UUID prevents
  // accidental reuse when a future admin replaces a photo.
  const match =
    /^products\/([1-9]\d*)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(jpg|jpeg|png|webp)$/.exec(
      key,
    );
  if (!match || Number(match[1]) !== productId) return null;
  return acceptedTypes.get(match[3]) ?? null;
}

function failure(status: number): Response {
  return new Response(null, {
    status,
    headers: { "Cache-Control": noStore },
  });
}

export async function deliverProductImage(
  env: Pick<Env, "PRODUCT_IMAGES" | "IMAGES">,
  productId: number,
  key: string,
  profile: ImageProfile,
): Promise<Response> {
  const expectedType = imageKeyContentType(key, productId);
  if (expectedType === null) return failure(404);

  let object: R2ObjectBody | null;
  try {
    object = await env.PRODUCT_IMAGES.get(key);
  } catch (error) {
    console.error("Product image R2 read failed", error);
    return failure(503);
  }
  if (object === null) {
    console.error("Product image R2 object missing", { productId });
    return failure(404);
  }
  if (
    object.httpMetadata?.contentType !== expectedType ||
    object.size > 20_000_000
  ) {
    console.error("Product image object metadata invalid", { productId });
    return failure(502);
  }

  try {
    const { width, quality } = imageProfiles[profile];
    const transformed = await env.IMAGES.input(object.body)
      .transform({ width, fit: "scale-down" })
      .output({ format: "image/webp", quality });
    const response = transformed.response({
      headers: { "Cache-Control": publicCache },
    });
    return response;
  } catch (error) {
    console.error("Product image transformation failed", error);
    return failure(502);
  }
}
