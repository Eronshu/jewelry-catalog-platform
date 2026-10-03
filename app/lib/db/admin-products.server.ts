import { mapProduct, type ProductRow } from "./catalog-mappers";
import type { Product, ProductStatus } from "./catalog-types";
import { slugCandidate, slugifyProductName } from "./slugs";
import { imageKeyContentType } from "../images/product-image.server";

export type ProductFields = {
  name: string;
  price: string;
  categoryId: string;
  material: string;
  colour: string;
  description: string;
  sku: string;
  quantity: string;
  facebookUrl: string;
};

export type FieldErrors = Partial<Record<keyof ProductFields, string>>;

export class AdminProductError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly fields: FieldErrors = {},
  ) {
    super(message);
  }
}

export const statuses: readonly ProductStatus[] = [
  "draft",
  "available",
  "sold",
  "hidden",
  "archived",
];

export function fieldsFromForm(form: FormData): ProductFields {
  const read = (key: keyof ProductFields) => String(form.get(key) ?? "");
  return {
    name: read("name"),
    price: read("price"),
    categoryId: read("categoryId"),
    material: read("material"),
    colour: read("colour"),
    description: read("description"),
    sku: read("sku"),
    quantity: read("quantity"),
    facebookUrl: read("facebookUrl"),
  };
}

export function fieldsFromProduct(product: Product): ProductFields {
  return {
    name: product.name,
    price: `${Math.floor(product.priceCents / 100)}.${String(product.priceCents % 100).padStart(2, "0")}`,
    categoryId: String(product.categoryId),
    material: product.material ?? "",
    colour: product.colour ?? "",
    description: product.description ?? "",
    sku: product.sku ?? "",
    quantity: product.quantity === null ? "" : String(product.quantity),
    facebookUrl: product.facebookUrl ?? "",
  };
}

type ValidFields = {
  name: string;
  priceCents: number;
  categoryId: number;
  material: string | null;
  colour: string | null;
  description: string | null;
  sku: string | null;
  quantity: number | null;
  facebookUrl: string | null;
};

export function validateProductFields(input: ProductFields): ValidFields {
  const errors: FieldErrors = {};
  const name = input.name.trim();
  if (!name || name.length > 120)
    errors.name = "Enter a name of up to 120 characters.";
  const price = input.price.trim();
  const priceMatch = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(price);
  if (!priceMatch)
    errors.price = "Enter a CAD price with up to two decimal places.";
  const priceCents = priceMatch
    ? Number(priceMatch[1]) * 100 + Number((priceMatch[2] ?? "").padEnd(2, "0"))
    : 0;
  const categoryId = Number(input.categoryId);
  if (!/^[1-9]\d*$/.test(input.categoryId) || !Number.isSafeInteger(categoryId))
    errors.categoryId = "Choose a category.";
  const optional = (raw: string, max: number, key: keyof ProductFields) => {
    const value = raw.trim();
    if (value.length > max) errors[key] = `Use ${max} characters or fewer.`;
    return value || null;
  };
  const material =
    optional(input.material, 80, "material")?.toLowerCase() ?? null;
  const colour = optional(input.colour, 80, "colour")?.toLowerCase() ?? null;
  const description = optional(input.description, 5000, "description");
  const sku = optional(input.sku, 64, "sku");
  if (sku && !/^[A-Za-z0-9_-]+$/.test(sku))
    errors.sku = "Use letters, numbers, hyphens or underscores.";
  const quantityText = input.quantity.trim();
  const quantity = quantityText === "" ? null : Number(quantityText);
  if (
    quantityText &&
    (!/^\d{1,6}$/.test(quantityText) || !Number.isSafeInteger(quantity))
  )
    errors.quantity = "Enter a nonnegative whole number or leave blank.";
  const facebookUrl = optional(input.facebookUrl, 2048, "facebookUrl");
  if (facebookUrl) {
    try {
      const url = new URL(facebookUrl);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        !["facebook.com", "www.facebook.com", "m.facebook.com"].includes(
          url.hostname,
        ) ||
        url.port
      )
        errors.facebookUrl = "Enter an HTTPS Facebook URL.";
    } catch {
      errors.facebookUrl = "Enter an HTTPS Facebook URL.";
    }
  }
  if (Object.keys(errors).length)
    throw new AdminProductError(
      "Please correct the highlighted fields.",
      400,
      errors,
    );
  return {
    name,
    priceCents,
    categoryId,
    material,
    colour,
    description,
    sku: sku?.toUpperCase() ?? null,
    quantity,
    facebookUrl,
  };
}

function positiveId(value: string): number {
  const id = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(id))
    throw new AdminProductError("Product not found.", 404);
  return id;
}

export function parseProductId(value: string): number {
  return positiveId(value);
}

export function parseVersion(value: string): number {
  const version = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(version))
    throw new AdminProductError("Refresh this product and try again.", 409);
  return version;
}

export type AdminListItem = {
  id: number;
  name: string;
  sku: string | null;
  priceCents: number;
  status: ProductStatus;
  updatedAt: number;
  categoryName: string;
  coverId: number | null;
};

export type AdminListOptions = { q: string; status: string; cursor: string };

export function normalizeAdminListFilters(q: string, status: string) {
  return {
    q: q.trim().slice(0, 100),
    status:
      status === "all" || statuses.includes(status as ProductStatus)
        ? status
        : "all",
  };
}

export async function listAdminProducts(
  db: D1Database,
  options: AdminListOptions,
) {
  const { q, status } = normalizeAdminListFilters(options.q, options.status);
  const conditions = [
    status === "all" ? "p.status <> 'archived'" : "p.status = ?",
  ];
  const binds: (string | number)[] = status === "all" ? [] : [status];
  if (q) {
    const escaped = q.replace(/[\\%_]/g, "\\$&");
    conditions.push(
      "(p.name LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR p.material LIKE ? ESCAPE '\\')",
    );
    binds.push(...Array(4).fill(`%${escaped}%`));
  }
  const match = /^(\d+):(\d+)$/.exec(options.cursor);
  if (match) {
    const at = Number(match[1]);
    const id = Number(match[2]);
    if (Number.isSafeInteger(at) && Number.isSafeInteger(id)) {
      conditions.push("(p.updated_at < ? OR (p.updated_at = ? AND p.id < ?))");
      binds.push(at, at, id);
    }
  }
  const rows = await db
    .prepare(
      `SELECT p.id, p.name, p.sku, p.price_cents, p.status, p.updated_at,
      c.name AS category_name,
      (SELECT i.id FROM product_images i WHERE i.product_id = p.id ORDER BY i.sort_order, i.id LIMIT 1) AS cover_id
    FROM products p JOIN categories c ON c.id = p.category_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY p.updated_at DESC, p.id DESC LIMIT 25`,
    )
    .bind(...binds)
    .all<{
      id: number;
      name: string;
      sku: string | null;
      price_cents: number;
      status: ProductStatus;
      updated_at: number;
      category_name: string;
      cover_id: number | null;
    }>();
  const items: AdminListItem[] = rows.results.slice(0, 24).map((row) => ({
    id: row.id,
    name: row.name,
    sku: row.sku,
    priceCents: row.price_cents,
    status: row.status,
    updatedAt: row.updated_at,
    categoryName: row.category_name,
    coverId: row.cover_id,
  }));
  const last = items.at(-1);
  return {
    items,
    q,
    status,
    nextCursor:
      rows.results.length > 24 && last ? `${last.updatedAt}:${last.id}` : null,
  };
}

export async function getAdminProduct(
  db: D1Database,
  id: number,
): Promise<Product | null> {
  const row = await db
    .prepare(
      `SELECT id, name, slug, sku, description, price_cents, category_id,
    material, colour, status, quantity, facebook_url, created_at, updated_at, published_at, sort_order
    FROM products WHERE id = ?`,
    )
    .bind(id)
    .first<ProductRow>();
  return row ? mapProduct(row) : null;
}

async function activeCategory(db: D1Database, id: number) {
  return db
    .prepare("SELECT id FROM categories WHERE id = ? AND is_active = 1")
    .bind(id)
    .first();
}

async function hashPayload(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function requestKey(value: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new AdminProductError("Refresh the form and try again.", 400);
  return value.toLowerCase();
}

export async function findCreationRequest(db: D1Database, rawKey: string) {
  const key = requestKey(rawKey);
  return db
    .prepare(
      "SELECT id, status, updated_at AS version, business_updated_at AS businessVersion FROM products WHERE creation_request_key = ?",
    )
    .bind(key)
    .first<{
      id: number;
      status: ProductStatus;
      version: number;
      businessVersion: number;
    }>();
}

async function replay(db: D1Database, key: string, hash: string) {
  const row = await db
    .prepare(
      "SELECT id, creation_request_hash AS hash FROM products WHERE creation_request_key = ?",
    )
    .bind(key)
    .first<{ id: number; hash: string }>();
  if (!row) return null;
  if (row.hash !== hash)
    throw new AdminProductError(
      "This request key was already used for different information.",
      409,
    );
  return row.id;
}

function databaseError(error: unknown): never {
  const message = String(error);
  if (message.includes("products.sku"))
    throw new AdminProductError("That SKU is already in use.", 400, {
      sku: "Choose a different SKU.",
    });
  throw error;
}

export async function createDraft(
  db: D1Database,
  input: ProductFields,
  rawKey: string,
) {
  const key = requestKey(rawKey);
  let fields: ValidFields;
  try {
    fields = validateProductFields(input);
  } catch (error) {
    const used = await db
      .prepare("SELECT id FROM products WHERE creation_request_key = ?")
      .bind(key)
      .first();
    if (used)
      throw new AdminProductError(
        "This request key was already used for different information.",
        409,
      );
    throw error;
  }
  const hash = await hashPayload(["create", fields]);
  const prior = await replay(db, key, hash);
  if (prior) return prior;
  if (!(await activeCategory(db, fields.categoryId)))
    throw new AdminProductError("Choose an active category.", 400, {
      categoryId: "Choose an active category.",
    });
  const base = slugifyProductName(fields.name);
  const now = Date.now();
  for (let attempt = 1; attempt <= 50; attempt++) {
    try {
      const row = await db
        .prepare(
          `INSERT INTO products
        (name, slug, sku, description, price_cents, category_id, material, colour, status, quantity,
         facebook_url, created_at, updated_at, business_updated_at, creation_request_key, creation_request_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        )
        .bind(
          fields.name,
          slugCandidate(base, attempt),
          fields.sku,
          fields.description,
          fields.priceCents,
          fields.categoryId,
          fields.material,
          fields.colour,
          fields.quantity,
          fields.facebookUrl,
          now,
          now,
          now,
          key,
          hash,
        )
        .first<{ id: number }>();
      return row!.id;
    } catch (error) {
      const raced = await replay(db, key, hash);
      if (raced) return raced;
      if (String(error).includes("products.slug")) continue;
      databaseError(error);
    }
  }
  throw new AdminProductError(
    "Could not create a unique product address.",
    409,
  );
}

export async function duplicateDraft(
  db: D1Database,
  sourceId: number,
  sourceVersion: number,
  rawKey: string,
) {
  const key = requestKey(rawKey);
  const hash = await hashPayload(["duplicate", sourceId, sourceVersion]);
  const prior = await replay(db, key, hash);
  if (prior) return prior;
  const source = await getAdminProduct(db, sourceId);
  if (!source) throw new AdminProductError("Product not found.", 404);
  if (source.status === "archived")
    throw new AdminProductError(
      "Restore this product before duplicating it.",
      409,
    );
  if (!(await activeCategory(db, source.categoryId)))
    throw new AdminProductError(
      "Choose an active category before duplicating this product.",
      400,
    );
  if (source.updatedAt !== sourceVersion)
    throw new AdminProductError(
      "This product changed. Refresh and try again.",
      409,
    );
  const base = slugifyProductName(`${source.name} copy`);
  const now = Date.now();
  for (let attempt = 1; attempt <= 50; attempt++) {
    try {
      const row = await db
        .prepare(
          `INSERT INTO products
        (name, slug, description, price_cents, category_id, material, colour, status,
         created_at, updated_at, business_updated_at, creation_request_key, creation_request_hash)
        SELECT ?, ?, description, price_cents, category_id, material, colour, 'draft', ?, ?, ?, ?, ?
        FROM products WHERE id = ? AND updated_at = ? RETURNING id`,
        )
        .bind(
          `${source.name} copy`,
          slugCandidate(base, attempt),
          now,
          now,
          now,
          key,
          hash,
          sourceId,
          sourceVersion,
        )
        .first<{ id: number }>();
      if (!row)
        throw new AdminProductError(
          "This product changed. Refresh and try again.",
          409,
        );
      return row.id;
    } catch (error) {
      const raced = await replay(db, key, hash);
      if (raced) return raced;
      if (String(error).includes("products.slug")) continue;
      if (error instanceof AdminProductError) throw error;
      databaseError(error);
    }
  }
  throw new AdminProductError(
    "Could not create a unique product address.",
    409,
  );
}

export type ProductIntent =
  | "save"
  | "publish"
  | "mark-sold"
  | "mark-available"
  | "hide"
  | "draft"
  | "archive"
  | "restore";

function nextStatus(
  current: ProductStatus,
  intent: ProductIntent,
): ProductStatus {
  if (current === "archived") {
    if (intent === "restore") return "draft";
    throw new AdminProductError("Restore this product before editing it.", 409);
  }
  if (intent === "save") return current;
  const target: Record<
    Exclude<ProductIntent, "save" | "restore">,
    ProductStatus
  > = {
    publish: "available",
    "mark-available": "available",
    "mark-sold": "sold",
    hide: "hidden",
    draft: "draft",
    archive: "archived",
  };
  if (intent === "restore")
    throw new AdminProductError("This product is not archived.", 409);
  const next = target[intent];
  if (current === next)
    throw new AdminProductError(
      "This product changed. Refresh and try again.",
      409,
    );
  return next;
}

type Cover = { id: number; r2_key: string };

async function publicationCover(
  db: D1Database,
  env: Env,
  productId: number,
): Promise<Cover> {
  const cover = await db
    .prepare(
      `SELECT id, r2_key FROM product_images WHERE product_id = ?
    ORDER BY sort_order, id LIMIT 1`,
    )
    .bind(productId)
    .first<Cover>();
  const type = cover && imageKeyContentType(cover.r2_key, productId);
  if (!cover || !type)
    throw new AdminProductError(
      "Add a usable photo before publishing this product.",
      400,
    );
  let object: R2Object | null;
  try {
    object = await env.PRODUCT_IMAGES.head(cover.r2_key);
  } catch {
    throw new AdminProductError("Could not check this photo. Try again.", 503);
  }
  if (
    !object ||
    object.size < 1 ||
    object.size > 20_000_000 ||
    object.httpMetadata?.contentType !== type
  )
    throw new AdminProductError(
      "Add a usable photo before publishing this product.",
      400,
    );
  return cover;
}

export async function changeProduct(
  env: Env,
  id: number,
  version: number,
  intent: ProductIntent,
  submitted?: ProductFields,
) {
  const db = env.DB;
  const old = await getAdminProduct(db, id);
  if (!old) throw new AdminProductError("Product not found.", 404);
  if (old.updatedAt !== version)
    throw new AdminProductError(
      "This product changed. Refresh and try again.",
      409,
    );
  const status = nextStatus(old.status, intent);
  if (intent === "restore" && submitted)
    throw new AdminProductError("Restore first, then edit the product.", 409);
  const fields = submitted ? validateProductFields(submitted) : null;
  if (
    fields &&
    fields.categoryId !== old.categoryId &&
    !(await activeCategory(db, fields.categoryId))
  )
    throw new AdminProductError("Choose an active category.", 400, {
      categoryId: "Choose an active category.",
    });
  const becomingPublic =
    !["available", "sold"].includes(old.status) &&
    ["available", "sold"].includes(status);
  const cover = becomingPublic ? await publicationCover(db, env, id) : null;
  const now = Math.max(Date.now(), old.updatedAt + 1);
  const coverCheck = cover
    ? ` AND EXISTS (SELECT 1 FROM product_images i WHERE i.id = ? AND i.product_id = products.id
    AND i.r2_key = ? AND NOT EXISTS (SELECT 1 FROM product_images earlier
      WHERE earlier.product_id = i.product_id AND (earlier.sort_order < i.sort_order OR
      (earlier.sort_order = i.sort_order AND earlier.id < i.id))))`
    : "";
  const updates = fields
    ? `name = ?, sku = ?, description = ?, price_cents = ?, category_id = ?,
    material = ?, colour = ?, quantity = ?, facebook_url = ?, `
    : "";
  const values: (string | number | null)[] = fields
    ? [
        fields.name,
        fields.sku,
        fields.description,
        fields.priceCents,
        fields.categoryId,
        fields.material,
        fields.colour,
        fields.quantity,
        fields.facebookUrl,
      ]
    : [];
  values.push(
    status,
    now,
    now,
    status === "available" || status === "sold" ? now : null,
    id,
    version,
    old.status,
  );
  if (cover) values.push(cover.id, cover.r2_key);
  let result: D1Result;
  try {
    result = await db
      .prepare(
        `UPDATE products SET ${updates}status = ?, updated_at = ?, business_updated_at = ?,
      published_at = CASE WHEN published_at IS NULL THEN ? ELSE published_at END
      WHERE id = ? AND updated_at = ? AND status = ?${coverCheck}`,
      )
      .bind(...values)
      .run();
  } catch (error) {
    if (String(error).includes("products.sku")) databaseError(error);
    if (String(error).includes("public product requires an image"))
      throw new AdminProductError(
        "Add a usable photo before publishing this product.",
        400,
      );
    throw error;
  }
  if (result.meta.changes !== 1)
    throw new AdminProductError(
      "This product changed. Refresh and try again.",
      409,
    );
  return now;
}
