import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { listActiveCategories } from "./categories.server";
import { shopData } from "../shop-data.server";
import {
  getPublicImageSource,
  getPublicProductBySlug,
  listPublicProducts,
  listPublicProductPage,
  listPublicFacets,
} from "./products.server";

const root = resolve(process.cwd());
const wrangler = join(root, "node_modules", ".bin", "wrangler");
let localDir: string;
let platform: PlatformProxy<Env>;
let db: D1Database;

async function insertProduct(
  slug: string,
  status: string,
  createdAt: number,
  categoryId = 1,
) {
  const product = await db
    .prepare(
      `INSERT INTO products
       (name, slug, price_cents, category_id, material, colour, status,
        created_at, updated_at)
       VALUES (?, ?, 2599, ?, 'silver', 'black', 'draft', ?, ?)
       RETURNING id`,
    )
    .bind(slug, slug, categoryId, createdAt, createdAt)
    .first<{ id: number }>();

  if (status === "available" || status === "sold") {
    await db
      .prepare(
        `INSERT INTO product_images
         (product_id, r2_key, sort_order, created_at)
         VALUES (?, ?, 0, ?)`,
      )
      .bind(product!.id, `tests/${slug}/01.jpg`, createdAt)
      .run();
  }
  if (status !== "draft") {
    await db
      .prepare("UPDATE products SET status = ? WHERE id = ?")
      .bind(status, product!.id)
      .run();
  }
  return product;
}

beforeAll(async () => {
  localDir = mkdtempSync(join(tmpdir(), "jewelry-catalog-d1-test-"));
  execFileSync(
    wrangler,
    ["d1", "migrations", "apply", "DB", "--local", "--persist-to", localDir],
    {
      cwd: root,
      env: {
        ...process.env,
        CI: "1",
        WRANGLER_LOG_PATH: join(localDir, "wrangler.log"),
      },
      stdio: "pipe",
    },
  );
  platform = await getPlatformProxy<Env>({
    configPath: join(root, "wrangler.jsonc"),
    envFiles: [],
    persist: { path: join(localDir, "v3") },
    remoteBindings: false,
  });
  db = platform.env.DB;
}, 30_000);

beforeEach(async () => {
  await db.prepare("DELETE FROM products").run();
});

afterAll(async () => {
  await platform?.dispose();
  if (localDir) rmSync(localDir, { recursive: true, force: true });
});

describe("the migrated local D1 schema", () => {
  it("has the four active baseline categories", async () => {
    const categories = await listActiveCategories(db);
    expect(categories.map(({ slug }) => slug)).toEqual([
      "earrings",
      "necklaces",
      "bracelets",
      "rings",
    ]);
  });

  it("enforces integer cents, status, slug uniqueness, and category references", async () => {
    await insertProduct("pearl-drop", "draft", 1000);
    await expect(insertProduct("PEARL-DROP", "draft", 1001)).rejects.toThrow();
    await expect(
      insertProduct("invalid-status", "pending", 1002),
    ).rejects.toThrow();
    await expect(
      insertProduct("bad-category", "draft", 1003, 999),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          `INSERT INTO products
           (name, slug, price_cents, category_id, created_at, updated_at)
           VALUES ('Bad price', 'bad-price', 1.5, 1, 1000, 1000)`,
        )
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          `INSERT INTO products
           (name, slug, price_cents, category_id, material, created_at, updated_at)
           VALUES ('Bad material', 'bad-material', 100, 1, ' Silver ', 1000, 1000)`,
        )
        .run(),
    ).rejects.toThrow();
  });

  it("rejects whitespace-only product names and negative numeric values", async () => {
    for (const [index, name] of [
      "   ",
      "\t",
      "\n",
      " \t\n ",
      "\u00a0",
      "\u2009",
    ].entries()) {
      await expect(
        db
          .prepare(
            `INSERT INTO products
             (name, slug, price_cents, category_id, created_at, updated_at)
             VALUES (?, ?, 100, 1, 1000, 1000)`,
          )
          .bind(name, `whitespace-${index}`)
          .run(),
      ).rejects.toThrow();
    }

    await expect(
      db
        .prepare(
          `INSERT INTO products
           (name, slug, price_cents, category_id, created_at, updated_at)
           VALUES ('Negative price', 'negative-price', -1, 1, 1000, 1000)`,
        )
        .run(),
    ).rejects.toThrow();

    const product = await insertProduct("quantity-check", "draft", 1000);
    await expect(
      db
        .prepare("UPDATE products SET quantity = -1 WHERE id = ?")
        .bind(product!.id)
        .run(),
    ).rejects.toThrow();
  });

  it("rejects duplicate non-null SKUs while allowing multiple NULL SKUs", async () => {
    const first = await insertProduct("sku-first", "draft", 1000);
    const second = await insertProduct("sku-second", "draft", 1001);
    const third = await insertProduct("sku-third", "draft", 1002);

    await db
      .prepare("UPDATE products SET sku = 'DEMO-001' WHERE id = ?")
      .bind(first!.id)
      .run();
    await expect(
      db
        .prepare("UPDATE products SET sku = 'demo-001' WHERE id = ?")
        .bind(second!.id)
        .run(),
    ).rejects.toThrow();
    const nullSkus = await db
      .prepare("SELECT COUNT(*) AS count FROM products WHERE sku IS NULL")
      .first<{ count: number }>();
    expect(nullSkus?.count).toBe(2);
    expect(third?.id).toBeTypeOf("number");
  });

  it("requires image width and height to be both present or both absent", async () => {
    const product = await insertProduct("image-dimensions", "draft", 1000);
    const insert = (key: string, width: number | null, height: number | null) =>
      db
        .prepare(
          `INSERT INTO product_images
           (product_id, r2_key, sort_order, width, height, created_at)
           VALUES (?, ?, 0, ?, ?, 1000)`,
        )
        .bind(product!.id, key, width, height)
        .run();

    await expect(insert("tests/width-only.jpg", 1200, null)).rejects.toThrow();
    await expect(insert("tests/height-only.jpg", null, 1200)).rejects.toThrow();
    await expect(insert("tests/zero-width.jpg", 0, 1200)).rejects.toThrow();
    await insert("tests/dimensions.jpg", 1200, 800);
  });

  it("restricts deletion of a used category and cascades deleted image metadata", async () => {
    const product = await insertProduct("with-image", "draft", 1000);
    await db
      .prepare(
        `INSERT INTO product_images
         (product_id, r2_key, sort_order, created_at)
         VALUES (?, 'tests/with-image.jpg', 0, 1000)`,
      )
      .bind(product!.id)
      .run();
    await expect(
      db.prepare("DELETE FROM categories WHERE id = 1").run(),
    ).rejects.toThrow();
    await db
      .prepare("DELETE FROM products WHERE id = ?")
      .bind(product!.id)
      .run();
    const image = await db
      .prepare("SELECT id FROM product_images WHERE product_id = ?")
      .bind(product!.id)
      .first();
    expect(image).toBeNull();
  });

  it("preserves image cascading when a public parent product is deleted", async () => {
    const product = await insertProduct("public-cascade", "available", 1000);
    await db
      .prepare("DELETE FROM products WHERE id = ?")
      .bind(product!.id)
      .run();
    const image = await db
      .prepare("SELECT id FROM product_images WHERE product_id = ?")
      .bind(product!.id)
      .first();
    expect(image).toBeNull();
  });

  it("enforces one position per product and derives the cover from ordering", async () => {
    const product = await insertProduct("ordered-images", "draft", 1000);
    await db.batch([
      db
        .prepare(
          `INSERT INTO product_images
           (product_id, r2_key, alt_text, sort_order, created_at)
           VALUES (?, 'tests/second.jpg', 'Second', 2, 1000)`,
        )
        .bind(product!.id),
      db
        .prepare(
          `INSERT INTO product_images
           (product_id, r2_key, alt_text, sort_order, created_at)
           VALUES (?, 'tests/first.jpg', 'First', 0, 1000)`,
        )
        .bind(product!.id),
    ]);
    await expect(
      db
        .prepare(
          `INSERT INTO product_images
           (product_id, r2_key, sort_order, created_at)
           VALUES (?, 'tests/duplicate.jpg', 0, 1000)`,
        )
        .bind(product!.id)
        .run(),
    ).rejects.toThrow();

    await db
      .prepare("UPDATE products SET status = 'available' WHERE id = ?")
      .bind(product!.id)
      .run();

    const imageIds = await db
      .prepare("SELECT id, r2_key FROM product_images WHERE product_id = ?")
      .bind(product!.id)
      .all<{ id: number; r2_key: string }>();
    const firstId = imageIds.results.find(
      (row) => row.r2_key === "tests/first.jpg",
    )!.id;
    const secondId = imageIds.results.find(
      (row) => row.r2_key === "tests/second.jpg",
    )!.id;
    const [card] = await listPublicProducts(db);
    expect(card.coverImage?.id).toBe(firstId);
    expect(JSON.stringify(card)).not.toContain("r2Key");
    const detail = await getPublicProductBySlug(db, "ordered-images");
    expect(detail?.images.map(({ sortOrder }) => sortOrder)).toEqual([0, 2]);

    await db.batch([
      db.prepare(
        "UPDATE product_images SET sort_order = 10 WHERE r2_key = 'tests/first.jpg'",
      ),
      db.prepare(
        "UPDATE product_images SET sort_order = 11 WHERE r2_key = 'tests/second.jpg'",
      ),
      db.prepare(
        "UPDATE product_images SET sort_order = 0 WHERE r2_key = 'tests/second.jpg'",
      ),
      db.prepare(
        "UPDATE product_images SET sort_order = 1 WHERE r2_key = 'tests/first.jpg'",
      ),
    ]);
    expect((await listPublicProducts(db))[0].coverImage?.id).toBe(secondId);
    expect(
      (await getPublicProductBySlug(db, "ordered-images"))?.images.map(
        (image) => image.id,
      ),
    ).toEqual([secondId, firstId]);
  });
});

describe("the public image invariant", () => {
  it("rejects direct public inserts and transitions to either public status without an image", async () => {
    for (const status of ["available", "sold"]) {
      await expect(
        db
          .prepare(
            `INSERT INTO products
             (name, slug, price_cents, category_id, status, created_at, updated_at)
             VALUES ('Direct public', ?, 100, 1, ?, 1000, 1000)`,
          )
          .bind(`direct-${status}`, status)
          .run(),
      ).rejects.toThrow("public product requires an image");
    }

    const product = await insertProduct("no-image", "draft", 1000);
    for (const status of ["available", "sold"]) {
      await expect(
        db
          .prepare("UPDATE products SET status = ? WHERE id = ?")
          .bind(status, product!.id)
          .run(),
      ).rejects.toThrow("public product requires an image");
    }
  });

  it("allows publication after adding an image and blocks removal of the final public image", async () => {
    const product = await insertProduct("public-image", "draft", 1000);
    await db
      .prepare(
        `INSERT INTO product_images
         (product_id, r2_key, sort_order, created_at)
         VALUES (?, 'tests/public-image/01.jpg', 0, 1000)`,
      )
      .bind(product!.id)
      .run();
    await db
      .prepare("UPDATE products SET status = 'available' WHERE id = ?")
      .bind(product!.id)
      .run();
    await expect(
      db
        .prepare("DELETE FROM product_images WHERE product_id = ?")
        .bind(product!.id)
        .run(),
    ).rejects.toThrow("public product requires an image");

    await db
      .prepare(
        `INSERT INTO product_images
         (product_id, r2_key, sort_order, created_at)
         VALUES (?, 'tests/public-image/02.jpg', 1, 1000)`,
      )
      .bind(product!.id)
      .run();
    await db
      .prepare(
        "DELETE FROM product_images WHERE r2_key = 'tests/public-image/01.jpg'",
      )
      .run();
    await db
      .prepare("UPDATE products SET status = 'sold' WHERE id = ?")
      .bind(product!.id)
      .run();
    await expect(
      db
        .prepare("DELETE FROM product_images WHERE product_id = ?")
        .bind(product!.id)
        .run(),
    ).rejects.toThrow("public product requires an image");
  });

  it("allows image removal from non-public products", async () => {
    for (const status of ["draft", "hidden", "archived"]) {
      const product = await insertProduct(`${status}-image`, status, 1000);
      await db
        .prepare(
          `INSERT INTO product_images
           (product_id, r2_key, sort_order, created_at)
           VALUES (?, ?, 0, 1000)`,
        )
        .bind(product!.id, `tests/${status}-image/01.jpg`)
        .run();
      await db
        .prepare("DELETE FROM product_images WHERE product_id = ?")
        .bind(product!.id)
        .run();
    }
    const remaining = await db
      .prepare("SELECT COUNT(*) AS count FROM product_images")
      .first<{ count: number }>();
    expect(remaining?.count).toBe(0);
  });

  it("cannot move the last image away from a public product", async () => {
    const publicProduct = await insertProduct("move-source", "available", 1000);
    const draftProduct = await insertProduct("move-target", "draft", 1000);
    await expect(
      db
        .prepare(
          "UPDATE product_images SET product_id = ? WHERE product_id = ?",
        )
        .bind(draftProduct!.id, publicProduct!.id)
        .run(),
    ).rejects.toThrow("public product requires an image");
  });

  it("rejects an r2_key REPLACE that would orphan a public product", async () => {
    const source = await insertProduct("replace-key-source", "available", 1000);
    const target = await insertProduct("replace-key-target", "draft", 1000);

    await expect(
      db
        .prepare(
          `INSERT OR REPLACE INTO product_images
           (product_id, r2_key, sort_order, created_at)
           VALUES (?, 'tests/replace-key-source/01.jpg', 0, 1000)`,
        )
        .bind(target!.id)
        .run(),
    ).rejects.toThrow("public product requires an image");

    const sourceImage = await db
      .prepare("SELECT product_id FROM product_images WHERE r2_key = ?")
      .bind("tests/replace-key-source/01.jpg")
      .first<{ product_id: number }>();
    expect(sourceImage?.product_id).toBe(source!.id);
  });

  it("rejects an id REPLACE that would orphan a public product", async () => {
    const source = await insertProduct("replace-id-source", "sold", 1000);
    const target = await insertProduct("replace-id-target", "draft", 1000);
    const sourceImage = await db
      .prepare("SELECT id FROM product_images WHERE product_id = ?")
      .bind(source!.id)
      .first<{ id: number }>();

    await expect(
      db
        .prepare(
          `INSERT OR REPLACE INTO product_images
           (id, product_id, r2_key, sort_order, created_at)
           VALUES (?, ?, 'tests/replacement-id.jpg', 0, 1000)`,
        )
        .bind(sourceImage!.id, target!.id)
        .run(),
    ).rejects.toThrow("public product requires an image");

    const retained = await db
      .prepare("SELECT id FROM product_images WHERE product_id = ?")
      .bind(source!.id)
      .first<{ id: number }>();
    expect(retained?.id).toBe(sourceImage!.id);
  });

  it("rejects a REPLACE with r2_key and position conflicts across public products", async () => {
    const source = await insertProduct(
      "replace-position-source",
      "available",
      1000,
    );
    const target = await insertProduct("replace-position-target", "sold", 1000);

    await expect(
      db
        .prepare(
          `INSERT OR REPLACE INTO product_images
           (product_id, r2_key, sort_order, created_at)
           VALUES (?, 'tests/replace-position-source/01.jpg', 0, 1000)`,
        )
        .bind(target!.id)
        .run(),
    ).rejects.toThrow("public product requires an image");

    const images = await db
      .prepare(
        `SELECT product_id, COUNT(*) AS count FROM product_images
         WHERE product_id IN (?, ?) GROUP BY product_id ORDER BY product_id`,
      )
      .bind(source!.id, target!.id)
      .all<{ product_id: number; count: number }>();
    expect(images.results.map(({ count }) => count)).toEqual([1, 1]);
  });

  it("allows replacement and metadata updates when a public image remains", async () => {
    const source = await insertProduct(
      "safe-replace-source",
      "available",
      1000,
    );
    const draft = await insertProduct("safe-replace-target", "draft", 1000);

    await db
      .prepare(
        `INSERT OR REPLACE INTO product_images
         (product_id, r2_key, alt_text, sort_order, created_at)
         VALUES (?, 'tests/safe-replace-source/01.jpg', 'Updated view', 0, 1000)`,
      )
      .bind(source!.id)
      .run();
    await db
      .prepare(
        `UPDATE product_images SET alt_text = 'Edited view', width = 1200,
         height = 900 WHERE product_id = ?`,
      )
      .bind(source!.id)
      .run();
    const retained = await db
      .prepare(
        `SELECT alt_text, width, height FROM product_images
         WHERE product_id = ?`,
      )
      .bind(source!.id)
      .first<{ alt_text: string; width: number; height: number }>();
    expect(retained).toMatchObject({
      alt_text: "Edited view",
      width: 1200,
      height: 900,
    });

    await db
      .prepare(
        `INSERT INTO product_images
         (product_id, r2_key, sort_order, created_at)
         VALUES (?, 'tests/safe-replace-source/02.jpg', 1, 1000)`,
      )
      .bind(source!.id)
      .run();
    await db
      .prepare(
        `INSERT OR REPLACE INTO product_images
         (product_id, r2_key, sort_order, created_at)
         VALUES (?, 'tests/safe-replace-source/01.jpg', 0, 1000)`,
      )
      .bind(draft!.id)
      .run();
    const stillPublic = await db
      .prepare(
        "SELECT COUNT(*) AS count FROM product_images WHERE product_id = ?",
      )
      .bind(source!.id)
      .first<{ count: number }>();
    expect(stillPublic?.count).toBe(1);
  });

  it("rejects UPDATE OR REPLACE when its implicit deletion would orphan a public product", async () => {
    const source = await insertProduct(
      "update-replace-source",
      "available",
      1000,
    );
    const draft = await insertProduct("update-replace-target", "draft", 1000);
    await db
      .prepare(
        `INSERT INTO product_images
         (product_id, r2_key, sort_order, created_at)
         VALUES (?, 'tests/update-replace-target/01.jpg', 0, 1000)`,
      )
      .bind(draft!.id)
      .run();

    await expect(
      db
        .prepare(
          `UPDATE OR REPLACE product_images
           SET r2_key = 'tests/update-replace-source/01.jpg'
           WHERE product_id = ?`,
        )
        .bind(draft!.id)
        .run(),
    ).rejects.toThrow("public product requires an image");

    const sourceImage = await db
      .prepare("SELECT id FROM product_images WHERE product_id = ?")
      .bind(source!.id)
      .first();
    expect(sourceImage).not.toBeNull();
  });
});

describe("public catalog reads", () => {
  it("returns a reset signal for a cursor whose anchor becomes hidden", async () => {
    for (let index = 0; index < 25; index++)
      await insertProduct(`cursor-${index}`, "available", 1000 + index);
    const first = await shopData(db, new URL("https://example.com/shop"));
    if (!("page" in first)) throw new Error("Expected first page");
    expect(first.page.products).toHaveLength(24);
    expect(first.page.nextCursor).toBeTruthy();
    const nextUrl = new URL(
      `https://example.com/shop?after=${first.page.nextCursor}`,
    );
    const next = await shopData(db, nextUrl, true);
    expect("page" in next && next.page.products).toHaveLength(1);
    const anchorSlug = first.page.products.at(-1)!.slug;
    await db
      .prepare("UPDATE products SET status = 'hidden' WHERE slug = ?")
      .bind(anchorSlug)
      .run();
    expect(await shopData(db, nextUrl, true)).toEqual({
      resetUrl: "/shop",
      stale: true,
    });
  });
  it("searches names literally, combines filters, and excludes private facets", async () => {
    const matches = await insertProduct(
      "silver-literal-ring",
      "available",
      1000,
    );
    await db
      .prepare(
        "UPDATE products SET name = 'Silver 50% _ Ring', sku = 'SECRET-ONLY' WHERE id = ?",
      )
      .bind(matches!.id)
      .run();
    const privateProduct = await insertProduct(
      "private-secret",
      "hidden",
      1001,
    );
    await db
      .prepare(
        "UPDATE products SET name = 'Secret', material = 'private metal', colour = 'private red' WHERE id = ?",
      )
      .bind(privateProduct!.id)
      .run();
    const found = await listPublicProductPage(db, {
      q: "50% _",
      categoryId: 1,
      material: "SILVER",
      colour: "BLACK",
      availability: "available",
    });
    expect(found.products.map((item) => item.id)).toEqual([matches!.id]);
    expect(
      (await listPublicProductPage(db, { q: "SECRET-ONLY" })).products,
    ).toEqual([]);
    expect((await listPublicProductPage(db, { q: "%" })).products).toHaveLength(
      1,
    );
    expect((await listPublicProductPage(db, { q: "_" })).products).toHaveLength(
      1,
    );
    const facets = await listPublicFacets(db);
    expect(facets).toEqual({ materials: ["silver"], colours: ["black"] });
  });

  it("uses stable price ties and 24-card boundaries", async () => {
    for (let index = 0; index < 49; index++) {
      const row = await insertProduct(
        `price-${index}`,
        "available",
        1000 + index,
      );
      await db
        .prepare("UPDATE products SET price_cents = ? WHERE id = ?")
        .bind(index < 3 ? 100 : 200 + index, row!.id)
        .run();
    }
    const first = await listPublicProductPage(db, { sort: "price-asc" });
    expect(first.products).toHaveLength(24);
    expect(first.hasMore).toBe(true);
    expect(first.products.slice(0, 3).map((item) => item.slug)).toEqual([
      "price-2",
      "price-1",
      "price-0",
    ]);
    const anchor = first.products.at(-1)!;
    const second = await listPublicProductPage(db, {
      sort: "price-asc",
      pageCursor: { key: anchor.priceCents, id: anchor.id },
    });
    expect(second.products).toHaveLength(24);
    expect(second.hasMore).toBe(true);
    const anchor2 = second.products.at(-1)!;
    const third = await listPublicProductPage(db, {
      sort: "price-asc",
      pageCursor: { key: anchor2.priceCents, id: anchor2.id },
    });
    expect(third.products).toHaveLength(1);
    expect(third.hasMore).toBe(false);
    expect(
      new Set(
        [...first.products, ...second.products, ...third.products].map(
          (item) => item.id,
        ),
      ).size,
    ).toBe(49);
    const descending = await listPublicProductPage(db, { sort: "price-desc" });
    expect(descending.products[0].slug).toBe("price-48");
  });
  it("bounds the initial Shop batch to 24 products", async () => {
    for (let index = 0; index < 25; index++) {
      await insertProduct(`bounded-${index}`, "available", 1000 + index);
    }
    const products = await listPublicProducts(db);
    expect(products).toHaveLength(24);
    expect(products[0].slug).toBe("bounded-24");
    expect(products.at(-1)?.slug).toBe("bounded-1");
  });

  it("reads changed price and status on a fresh public request", async () => {
    const product = await insertProduct("fresh-item", "available", 1000);
    expect(
      (await getPublicProductBySlug(db, "fresh-item"))?.product.priceCents,
    ).toBe(2599);
    await db
      .prepare(
        "UPDATE products SET price_cents = 3199, status = 'sold' WHERE id = ?",
      )
      .bind(product!.id)
      .run();
    expect(
      (await getPublicProductBySlug(db, "fresh-item"))?.product,
    ).toMatchObject({ priceCents: 3199, status: "sold" });
    await db
      .prepare("UPDATE products SET status = 'hidden' WHERE id = ?")
      .bind(product!.id)
      .run();
    expect(await getPublicProductBySlug(db, "fresh-item")).toBeNull();
    expect(await listPublicProducts(db)).toEqual([]);
  });

  it("does not return internal SKU in a public detail read", async () => {
    const product = await insertProduct("public-no-sku", "available", 1000);
    await db
      .prepare("UPDATE products SET sku = 'PRIVATE-QA-SKU' WHERE id = ?")
      .bind(product!.id)
      .run();
    const detail = await getPublicProductBySlug(db, "public-no-sku");
    expect(JSON.stringify(detail)).not.toContain("PRIVATE-QA-SKU");
    expect(detail?.product).not.toHaveProperty("sku");
  });

  it("authorizes an image only for its public parent product", async () => {
    const available = await insertProduct("visible-image", "available", 1000);
    const hidden = await insertProduct("hidden-image", "hidden", 1001);
    await db
      .prepare(
        `INSERT INTO product_images (product_id, r2_key, sort_order, created_at)
         VALUES (?, 'tests/hidden-image/01.jpg', 0, 1001)`,
      )
      .bind(hidden!.id)
      .run();
    const image = await db
      .prepare("SELECT id FROM product_images WHERE product_id = ?")
      .bind(available!.id)
      .first<{ id: number }>();
    const hiddenImage = await db
      .prepare("SELECT id FROM product_images WHERE product_id = ?")
      .bind(hidden!.id)
      .first<{ id: number }>();
    expect(await getPublicImageSource(db, available!.id, image!.id)).toEqual({
      r2Key: "tests/visible-image/01.jpg",
    });
    expect(
      await getPublicImageSource(db, hidden!.id, hiddenImage!.id),
    ).toBeNull();
    expect(
      await getPublicImageSource(db, available!.id, hiddenImage!.id),
    ).toBeNull();

    await db
      .prepare("UPDATE products SET status = 'archived' WHERE id = ?")
      .bind(available!.id)
      .run();
    // This proves the D1 check on a Worker execution. A prior Workers Cache
    // hit can bypass this query until its cache entry expires.
    expect(await getPublicImageSource(db, available!.id, image!.id)).toBeNull();
  });
  it("excludes draft, hidden, and archived records in list and slug reads", async () => {
    for (const [index, status] of [
      "draft",
      "available",
      "sold",
      "hidden",
      "archived",
    ].entries()) {
      await insertProduct(`${status}-item`, status, 1000 + index);
    }
    expect((await listPublicProducts(db)).map(({ slug }) => slug)).toEqual([
      "sold-item",
      "available-item",
    ]);
    expect(await getPublicProductBySlug(db, "draft-item")).toBeNull();
    expect(
      (await getPublicProductBySlug(db, "sold-item"))?.product.status,
    ).toBe("sold");
  });

  it("filters server-side and pages newest results with a stable cursor", async () => {
    await insertProduct("first", "available", 1000);
    await insertProduct("second", "sold", 1001);
    await insertProduct("third", "available", 1002, 2);

    const page = await listPublicProducts(db, { limit: 2 });
    expect(page.map(({ slug }) => slug)).toEqual(["third", "second"]);
    expect(
      (
        await listPublicProducts(db, {
          limit: 2,
          cursor: { createdAt: page[1].createdAt, id: page[1].id },
        })
      ).map(({ slug }) => slug),
    ).toEqual(["first"]);
    expect(
      (
        await listPublicProducts(db, {
          categoryId: 1,
          availability: "available",
        })
      ).map(({ slug }) => slug),
    ).toEqual(["first"]);
    expect(
      (await listPublicProducts(db, { material: "SILVER", colour: "black" }))
        .length,
    ).toBe(3);
  });

  it("pages deterministically when created timestamps tie", async () => {
    await insertProduct("tie-first", "available", 1000);
    await insertProduct("tie-second", "available", 1000);
    await insertProduct("tie-third", "sold", 1000);

    const firstPage = await listPublicProducts(db, { limit: 2 });
    expect(firstPage.map(({ slug }) => slug)).toEqual([
      "tie-third",
      "tie-second",
    ]);
    const nextPage = await listPublicProducts(db, {
      limit: 2,
      cursor: { createdAt: firstPage[1].createdAt, id: firstPage[1].id },
    });
    expect(nextPage.map(({ slug }) => slug)).toEqual(["tie-first"]);
  });

  it("keeps category filtering across cursor pages", async () => {
    await insertProduct("earring-first", "available", 1000, 1);
    await insertProduct("necklace-between", "available", 1000, 2);
    await insertProduct("earring-second", "available", 1000, 1);
    await insertProduct("earring-third", "sold", 1000, 1);

    const firstPage = await listPublicProducts(db, { categoryId: 1, limit: 2 });
    expect(firstPage.map(({ slug }) => slug)).toEqual([
      "earring-third",
      "earring-second",
    ]);
    const nextPage = await listPublicProducts(db, {
      categoryId: 1,
      limit: 2,
      cursor: { createdAt: firstPage[1].createdAt, id: firstPage[1].id },
    });
    expect(nextPage.map(({ slug }) => slug)).toEqual(["earring-first"]);
  });
});
