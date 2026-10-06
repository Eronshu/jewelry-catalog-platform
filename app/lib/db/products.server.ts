import {
  mapPublicProductDetail,
  mapPublicProductCard,
  type PublicProductDetailRow,
  type PublicProductImageRow,
  type PublicProductCardRow,
} from "./catalog-mappers";
import type { PublicProductCard, PublicProductDetail } from "./catalog-types";
import type { ShopSort } from "../shop-query";

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
  q?: string;
  sort?: ShopSort;
  pageCursor?: { key: number; id: number };
}

export interface PublicProductPage {
  products: PublicProductCard[];
  hasMore: boolean;
}

export async function listPublicFacets(db: D1Database) {
  const [materials, colours] = await Promise.all([
    db
      .prepare(
        "SELECT DISTINCT material AS value FROM products WHERE status IN ('available', 'sold') AND material IS NOT NULL ORDER BY material COLLATE NOCASE",
      )
      .all<{ value: string }>(),
    db
      .prepare(
        "SELECT DISTINCT colour AS value FROM products WHERE status IN ('available', 'sold') AND colour IS NOT NULL ORDER BY colour COLLATE NOCASE",
      )
      .all<{ value: string }>(),
  ]);
  return {
    materials: materials.results.map((row) => row.value),
    colours: colours.results.map((row) => row.value),
  };
}

export async function publicCatalogHasProducts(db: D1Database) {
  return (
    (await db
      .prepare(
        "SELECT 1 AS found FROM products WHERE status IN ('available', 'sold') LIMIT 1",
      )
      .first()) !== null
  );
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
  return (await listPublicProductPage(db, options)).products;
}

export async function listPublicProductPage(
  db: D1Database,
  options: ListPublicProductsOptions = {},
): Promise<PublicProductPage> {
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
  if (options.q) {
    conditions.push("p.name LIKE ? ESCAPE '\\' COLLATE NOCASE");
    const escaped = options.q.replace(/[\\%_]/g, (match) => `\\${match}`);
    values.push(`%${escaped}%`);
  }
  const sort = options.sort ?? "newest";
  const keyColumn = sort === "newest" ? "p.created_at" : "p.price_cents";
  const ascending = sort === "price-asc";
  const order = `${keyColumn} ${ascending ? "ASC" : "DESC"}, p.id DESC`;
  if (options.pageCursor) {
    conditions.push(
      `(${keyColumn} ${ascending ? ">" : "<"} ? OR (${keyColumn} = ? AND p.id < ?))`,
    );
    values.push(
      options.pageCursor.key,
      options.pageCursor.key,
      options.pageCursor.id,
    );
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
  values.push(limit + 1);

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
       ORDER BY ${order}
       LIMIT ?`,
    )
    .bind(...values)
    .all<PublicProductCardRow>();

  return {
    products: result.results.slice(0, limit).map(mapPublicProductCard),
    hasMore: result.results.length > limit,
  };
}

export async function publicCursorAnchorMatches(
  db: D1Database,
  id: number,
  key: number,
  sort: ShopSort,
  options: Pick<
    ListPublicProductsOptions,
    "categoryId" | "material" | "colour" | "availability" | "q"
  >,
) {
  const conditions = ["id = ?", "status IN ('available', 'sold')"];
  const values: (string | number)[] = [id];
  if (options.categoryId !== undefined) {
    conditions.push("category_id = ?");
    values.push(options.categoryId);
  }
  if (options.material) {
    conditions.push("material = ? COLLATE NOCASE");
    values.push(options.material);
  }
  if (options.colour) {
    conditions.push("colour = ? COLLATE NOCASE");
    values.push(options.colour);
  }
  if (options.availability) {
    conditions.push("status = ?");
    values.push(options.availability);
  }
  if (options.q) {
    conditions.push("name LIKE ? ESCAPE '\\' COLLATE NOCASE");
    values.push(`%${options.q.replace(/[\\%_]/g, (match) => `\\${match}`)}%`);
  }
  conditions.push(`${sort === "newest" ? "created_at" : "price_cents"} = ?`);
  values.push(key);
  return (
    (await db
      .prepare(
        `SELECT 1 AS found FROM products WHERE ${conditions.join(" AND ")} LIMIT 1`,
      )
      .bind(...values)
      .first()) !== null
  );
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
