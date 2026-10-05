import {
  mapPublicProductDetail,
  mapPublicProductCard,
  type PublicProductDetailRow,
  type PublicProductImageRow,
  type PublicProductCardRow,
} from "./catalog-mappers";
import type { PublicProductCard, PublicProductDetail } from "./catalog-types";

export interface PublicProductCursor {
  createdAt: number;
  id: number;
}

export interface ListPublicProductsOptions {
  limit?: number;
  cursor?: PublicProductCursor;
  categoryId?: number;
  material?: string;
  colour?: string;
  availability?: "available" | "sold";
}

export interface PublicImageSource {
  r2Key: string;
}

export async function getPublicImageSource(
  db: D1Database,
  productId: number,
  imageId: number,
): Promise<PublicImageSource | null> {
  const row = await db
    .prepare(
      `SELECT i.r2_key AS r2Key
       FROM product_images i
       JOIN products p ON p.id = i.product_id
       WHERE p.id = ? AND i.id = ? AND p.status IN ('available', 'sold')`,
    )
    .bind(productId, imageId)
    .first<PublicImageSource>();
  return row;
}

export async function listPublicProducts(
  db: D1Database,
  options: ListPublicProductsOptions = {},
): Promise<PublicProductCard[]> {
  const conditions = ["p.status IN ('available', 'sold')"];
  const values: (string | number)[] = [];

  if (options.categoryId !== undefined) {
    conditions.push("p.category_id = ?");
    values.push(options.categoryId);
  }
  if (options.material !== undefined) {
    conditions.push("p.material = ? COLLATE NOCASE");
    values.push(options.material.trim());
  }
  if (options.colour !== undefined) {
    conditions.push("p.colour = ? COLLATE NOCASE");
    values.push(options.colour.trim());
  }
  if (options.availability !== undefined) {
    conditions.push("p.status = ?");
    values.push(options.availability);
  }
  if (options.cursor !== undefined) {
    conditions.push("(p.created_at < ? OR (p.created_at = ? AND p.id < ?))");
    values.push(
      options.cursor.createdAt,
      options.cursor.createdAt,
      options.cursor.id,
    );
  }

  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 24), 1), 24);
  values.push(limit);

  const result = await db
    .prepare(
      `SELECT p.id, p.name, p.slug, p.price_cents, p.status, p.created_at,
              i.id AS cover_id,
              i.alt_text AS cover_alt_text, i.sort_order AS cover_sort_order,
              i.width AS cover_width, i.height AS cover_height
       FROM products p
       LEFT JOIN product_images i ON i.id = (
         SELECT image.id FROM product_images image
         WHERE image.product_id = p.id
         ORDER BY image.sort_order ASC, image.id ASC
         LIMIT 1
       )
       WHERE ${conditions.join(" AND ")}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT ?`,
    )
    .bind(...values)
    .all<PublicProductCardRow>();

  return result.results.map(mapPublicProductCard);
}

export async function getPublicProductBySlug(
  db: D1Database,
  slug: string,
): Promise<PublicProductDetail | null> {
  const row = await db
    .prepare(
      `SELECT id, name, slug, description, price_cents,
              material, colour, status, facebook_url
       FROM products
       WHERE slug = ? AND status IN ('available', 'sold')`,
    )
    .bind(slug)
    .first<PublicProductDetailRow>();

  if (row === null) return null;

  const images = await db
    .prepare(
      `SELECT id, alt_text, sort_order, width, height
       FROM product_images
       WHERE product_id = ?
       ORDER BY sort_order ASC, id ASC`,
    )
    .bind(row.id)
    .all<PublicProductImageRow>();

  return mapPublicProductDetail(row, images.results);
}
