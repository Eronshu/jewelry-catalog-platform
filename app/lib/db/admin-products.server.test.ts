import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { deliverProductImage } from "../images/product-image.server";
import {
  AdminProductError,
  changeProduct,
  createDraft,
  duplicateDraft,
  fieldsFromProduct,
  getAdminProduct,
  listAdminProducts,
  validateProductFields,
  type ProductFields,
} from "./admin-products.server";

const root = resolve(process.cwd());
const wrangler = join(root, "node_modules", ".bin", "wrangler");
function syntheticPng() {
  const table = Array.from({ length: 256 }, (_, n) => {
    let value = n;
    for (let bit = 0; bit < 8; bit++)
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  const chunk = (name: string, body: Buffer) => {
    const label = Buffer.from(name);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([label, body]))
      crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, label, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(8, 0);
  header.writeUInt32BE(8, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(8 * (1 + 8 * 3));
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      const offset = y * 25 + 1 + x * 3;
      pixels[offset] = x % 2 ? 220 : 30;
      pixels[offset + 1] = y % 2 ? 180 : 50;
      pixels[offset + 2] = 90;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const png = syntheticPng();
let localDir: string;
let platform: PlatformProxy<Env>;
let db: D1Database;

const fields = (name = "Orbit Ring"): ProductFields => ({
  name,
  price: "29.95",
  categoryId: "4",
  material: " Silver ",
  colour: " Black ",
  description: "Fictional sample",
  sku: "",
  quantity: "",
  facebookUrl: "",
});

beforeAll(async () => {
  localDir = mkdtempSync(join(tmpdir(), "jewelry-admin-d1-test-"));
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

async function draft(name = "Orbit Ring") {
  const id = await createDraft(db, fields(name), crypto.randomUUID());
  return (await getAdminProduct(db, id))!;
}

async function addRealImage(id: number) {
  const key = `products/${id}/${crypto.randomUUID()}.png`;
  await platform.env.PRODUCT_IMAGES.put(key, png, {
    httpMetadata: { contentType: "image/png" },
  });
  const row = await db
    .prepare(
      `INSERT INTO product_images (product_id, r2_key, sort_order, created_at)
    VALUES (?, ?, 0, ?) RETURNING id`,
    )
    .bind(id, key, Date.now())
    .first<{ id: number }>();
  return { key, imageId: row!.id };
}

describe("admin product validation", () => {
  it("parses exact CAD cents and normalizes text", () => {
    expect(validateProductFields(fields())).toMatchObject({
      priceCents: 2995,
      material: "silver",
      colour: "black",
      quantity: null,
    });
    for (const price of ["1.999", "-1", "1e3", "", "1000000", "1,00"]) {
      expect(() => validateProductFields({ ...fields(), price })).toThrow(
        AdminProductError,
      );
    }
  });

  it("rejects bad fields and unrelated URLs", () => {
    expect(() =>
      validateProductFields({
        ...fields(),
        name: "  ",
        sku: "bad space",
        quantity: "-1",
        facebookUrl: "https://evil.example/item",
      }),
    ).toThrow(AdminProductError);
  });
});

describe("admin D1 operations", () => {
  it("lists bounded products with status, search and a stable cursor", async () => {
    for (let i = 0; i < 27; i++) await draft(`Fictional Orbit ${i}`);
    const first = await listAdminProducts(db, {
      q: "Orbit",
      status: "all",
      cursor: "",
    });
    expect(first.items).toHaveLength(24);
    expect(first.nextCursor).toBeTruthy();
    const second = await listAdminProducts(db, {
      q: "Orbit",
      status: "all",
      cursor: first.nextCursor!,
    });
    expect(second.items).toHaveLength(3);
    expect(
      new Set([...first.items, ...second.items].map((item) => item.id)).size,
    ).toBe(27);
    expect(
      (await listAdminProducts(db, { q: "rings", status: "draft", cursor: "" }))
        .items,
    ).toHaveLength(24);
    expect(
      (await listAdminProducts(db, { q: "missing", status: "all", cursor: "" }))
        .items,
    ).toHaveLength(0);
    expect(
      (await listAdminProducts(db, { q: "%", status: "all", cursor: "" }))
        .items,
    ).toHaveLength(0);
  });

  it("replays create and duplicate after later edits, but rejects a changed payload", async () => {
    const key = crypto.randomUUID();
    const id = await createDraft(db, fields(), key);
    const original = (await getAdminProduct(db, id))!;
    await changeProduct(platform.env, id, original.updatedAt, "save", {
      ...fields(),
      name: "Changed Name",
    });
    expect(await createDraft(db, fields(), key)).toBe(id);
    await expect(createDraft(db, fields("Other"), key)).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      createDraft(db, { ...fields(), price: "invalid" }, key),
    ).rejects.toMatchObject({
      status: 409,
    });
    const duplicateKey = crypto.randomUUID();
    const edited = (await getAdminProduct(db, id))!;
    const copyId = await duplicateDraft(db, id, edited.updatedAt, duplicateKey);
    const copy = (await getAdminProduct(db, copyId))!;
    expect(copy).toMatchObject({
      status: "draft",
      sku: null,
      facebookUrl: null,
      quantity: null,
      publishedAt: null,
    });
    await changeProduct(platform.env, copyId, copy.updatedAt, "save", {
      ...fields(),
      name: "Edited copy",
    });
    expect(await duplicateDraft(db, id, edited.updatedAt, duplicateKey)).toBe(
      copyId,
    );
    await db.prepare("UPDATE categories SET is_active = 0 WHERE id = 4").run();
    try {
      expect(await createDraft(db, fields(), key)).toBe(id);
      expect(await duplicateDraft(db, id, edited.updatedAt, duplicateKey)).toBe(
        copyId,
      );
      await expect(
        duplicateDraft(db, id, edited.updatedAt, crypto.randomUUID()),
      ).rejects.toMatchObject({ status: 400 });
    } finally {
      await db
        .prepare("UPDATE categories SET is_active = 1 WHERE id = 4")
        .run();
    }
    await expect(
      duplicateDraft(db, id, edited.updatedAt + 1, duplicateKey),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await db
        .prepare("SELECT COUNT(*) AS n FROM products")
        .first<{ n: number }>())!.n,
    ).toBe(2);
  });

  it("uses the unique database key for concurrent create retries", async () => {
    const key = crypto.randomUUID();
    const results = await Promise.all([
      createDraft(db, fields(), key),
      createDraft(db, fields(), key),
    ]);
    expect(results[0]).toBe(results[1]);
    expect(
      (await db
        .prepare("SELECT COUNT(*) AS n FROM products")
        .first<{ n: number }>())!.n,
    ).toBe(1);
  });

  it("handles slug collisions, case-insensitive SKU conflicts and stale edits", async () => {
    const first = await draft();
    const second = await draft();
    expect(second.slug).toBe("orbit-ring-2");
    await changeProduct(platform.env, first.id, first.updatedAt, "save", {
      ...fields(),
      sku: "RING-1",
    });
    await expect(
      changeProduct(platform.env, second.id, second.updatedAt, "save", {
        ...fields(),
        sku: "ring-1",
      }),
    ).rejects.toMatchObject({ fields: { sku: "Choose a different SKU." } });
    await expect(
      changeProduct(platform.env, first.id, first.updatedAt, "hide"),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("requires a real image to publish and rechecks the selected cover", async () => {
    const product = await draft();
    await expect(
      changeProduct(platform.env, product.id, product.updatedAt, "publish"),
    ).rejects.toMatchObject({ status: 400 });
    const badKey = `dev/products/${product.id}/01.jpg`;
    await db
      .prepare(
        "INSERT INTO product_images (product_id, r2_key, sort_order, created_at) VALUES (?, ?, 0, ?)",
      )
      .bind(product.id, badKey, Date.now())
      .run();
    await expect(
      changeProduct(platform.env, product.id, product.updatedAt, "publish"),
    ).rejects.toMatchObject({ status: 400 });
    await db
      .prepare("DELETE FROM product_images WHERE product_id = ?")
      .bind(product.id)
      .run();
    const image = await addRealImage(product.id);
    await changeProduct(platform.env, product.id, product.updatedAt, "publish");
    const published = (await getAdminProduct(db, product.id))!;
    expect(published.status).toBe("available");
    expect(published.publishedAt).toBeTruthy();
    const response = await deliverProductImage(
      platform.env,
      product.id,
      image.key,
      "thumb",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("image/webp");
    await platform.env.PRODUCT_IMAGES.delete(image.key);
    await changeProduct(
      platform.env,
      product.id,
      published.updatedAt,
      "mark-sold",
    );
    expect((await getAdminProduct(db, product.id))!.status).toBe("sold");
  });

  it("leaves a Draft unchanged when its selected image row changes during publication", async () => {
    const product = await draft();
    const image = await addRealImage(product.id);
    const originalBucket = platform.env.PRODUCT_IMAGES;
    const env = {
      ...platform.env,
      PRODUCT_IMAGES: {
        head: async (key: string) => {
          const object = await originalBucket.head(key);
          await db
            .prepare("DELETE FROM product_images WHERE id = ?")
            .bind(image.imageId)
            .run();
          return object;
        },
      },
    } as unknown as Env;
    await expect(
      changeProduct(env, product.id, product.updatedAt, "publish"),
    ).rejects.toMatchObject({ status: 409 });
    expect((await getAdminProduct(db, product.id))!.status).toBe("draft");
  });

  it("preserves status on failed publication and restores Archived to Draft", async () => {
    const product = await draft();
    const key = `products/${product.id}/${crypto.randomUUID()}.png`;
    await db
      .prepare(
        "INSERT INTO product_images (product_id, r2_key, sort_order, created_at) VALUES (?, ?, 0, ?)",
      )
      .bind(product.id, key, Date.now())
      .run();
    await expect(
      changeProduct(platform.env, product.id, product.updatedAt, "publish"),
    ).rejects.toMatchObject({ status: 400 });
    expect((await getAdminProduct(db, product.id))!.status).toBe("draft");
    await changeProduct(platform.env, product.id, product.updatedAt, "archive");
    const archived = (await getAdminProduct(db, product.id))!;
    expect(
      (await listAdminProducts(db, { q: "", status: "all", cursor: "" })).items,
    ).toHaveLength(0);
    expect(
      (await listAdminProducts(db, { q: "", status: "archived", cursor: "" }))
        .items,
    ).toHaveLength(1);
    await expect(
      changeProduct(
        platform.env,
        product.id,
        archived.updatedAt,
        "save",
        fieldsFromProduct(archived),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await changeProduct(
      platform.env,
      product.id,
      archived.updatedAt,
      "restore",
    );
    expect((await getAdminProduct(db, product.id))!.status).toBe("draft");
  });

  it("supports the permitted status transitions without rewriting first publication time", async () => {
    const product = await draft();
    await addRealImage(product.id);
    for (const [intent, expected] of [
      ["hide", "hidden"],
      ["mark-sold", "sold"],
      ["mark-available", "available"],
      ["draft", "draft"],
      ["publish", "available"],
      ["mark-sold", "sold"],
      ["hide", "hidden"],
      ["draft", "draft"],
      ["archive", "archived"],
      ["restore", "draft"],
    ] as const) {
      const before = (await getAdminProduct(db, product.id))!;
      await changeProduct(platform.env, product.id, before.updatedAt, intent);
      const after = (await getAdminProduct(db, product.id))!;
      expect(after.status).toBe(expected);
      expect(after.updatedAt).toBeGreaterThan(before.updatedAt);
      if (before.publishedAt)
        expect(after.publishedAt).toBe(before.publishedAt);
    }
  });
});
