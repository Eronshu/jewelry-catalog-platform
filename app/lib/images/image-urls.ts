import type { ImageProfile } from "./image-profiles";

export function productImageUrl(
  productId: number,
  imageId: number,
  profile: ImageProfile,
): string {
  if (
    !Number.isSafeInteger(productId) ||
    productId < 1 ||
    !Number.isSafeInteger(imageId) ||
    imageId < 1
  ) {
    throw new Error("Invalid product image identity");
  }
  return `/media/products/${productId}/${imageId}/${profile}`;
}
