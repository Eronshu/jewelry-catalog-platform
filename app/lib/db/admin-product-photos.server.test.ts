import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createDraft,
  changeProduct,
  type ProductFields,
} from "./admin-products.server";
import {
  abandonStaleUpload,
  adminPhotoSource,
  editPhotoAlt,
  listAdminPhotos,
  reconcileAbandonedUpload,
  reconcileRemovedUpload,
  removePhoto,
  reorderPhotos,
  uploadPhoto,
} from "./admin-product-photos.server";
import { deliverProductImage } from "../images/product-image.server";

const root = resolve(process.cwd());
const png = readFileSync(resolve("tests/fixtures/still-photo.png"));
let localDir: string;
let platform: PlatformProxy<Env>;
let db: D1Database;
const fields: ProductFields = {
  name: "Synthetic Ring",
  price: "29.95",
  categoryId: "4",
  material: "",
  colour: "",
  description: "",
  sku: "",
  quantity: "",
  facebookUrl: "",
};

beforeAll(async () => {
  localDir = mkdtempSync(join(tmpdir(), "jewelry-photo-test-"));
  execFileSync(
    join(root, "node_modules", ".bin", "wrangler"),
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
async function draft() {
  return createDraft(db, fields, crypto.randomUUID());
}
async function request(
  id: string,
  version: number,
  body = png,
  claim?: string,
  contentType = "image/png",
) {
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", body)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  return new Request("https://example.invalid/admin/upload", {
    method: "POST",
    body: Uint8Array.from(body),
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(body.length),
      "X-Upload-Id": id,
      "X-Photo-Sha256": claim ?? hash,
      "X-Product-Version": String(version),
    },
  });
}

describe("isolated photo D1/R2 workflow", () => {
  it("stores exact original bytes, retries one identity, and publishes a Draft", async () => {
    const id = await draft();
    const version = (await db
      .prepare("SELECT updated_at FROM products WHERE id = ?")
      .bind(id)
      .first<{ updated_at: number }>())!.updated_at;
    const uploadId = crypto.randomUUID();
    const first = await uploadPhoto(
      platform.env,
      id,
      await request(uploadId, version),
    );
    expect(first.photos).toHaveLength(1);
    expect(first.photos[0].width).toBe(64);
    const row = await db
      .prepare("SELECT r2_key FROM product_images WHERE upload_id = ?")
      .bind(uploadId)
      .first<{ r2_key: string }>();
    expect(row!.r2_key).toBe(`products/${id}/${uploadId}.png`);
    const stored = await platform.env.PRODUCT_IMAGES.get(row!.r2_key);
    expect(stored?.httpMetadata?.contentType).toBe("image/png");
    expect(Buffer.from(await stored!.arrayBuffer())).toEqual(png);
    const repeated = await uploadPhoto(
      platform.env,
      id,
      await request(uploadId, version),
    );
    expect(repeated.photos).toHaveLength(1);
    expect(repeated.version).toBe(first.version);
    await expect(
      changeProduct(platform.env, id, first.version, "publish", fields),
    ).resolves.toBeGreaterThan(first.version);
  });
  it("does not trust a repeated digest header when the bytes differ", async () => {
    const id = await draft();
    const version = (await db
      .prepare("SELECT updated_at FROM products WHERE id = ?")
      .bind(id)
      .first<{ updated_at: number }>())!.updated_at;
    const uploadId = crypto.randomUUID();
    await uploadPhoto(platform.env, id, await request(uploadId, version));
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", png)),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    const different = Buffer.from(png);
    different[different.length - 1] ^= 1;
    await expect(
      uploadPhoto(
        platform.env,
        id,
        await request(uploadId, version, different, hash),
      ),
    ).rejects.toThrow(/different file/);
    await expect(
      uploadPhoto(
        platform.env,
        id,
        await request(
          uploadId,
          version,
          readFileSync(resolve("tests/fixtures/still-photo.webp")),
          undefined,
          "image/webp",
        ),
      ),
    ).rejects.toThrow(/different file/);
    expect(await listAdminPhotos(db, id)).toHaveLength(1);
  });
  it("accepts still JPEG and WebP originals without changing their bytes", async () => {
    const id = await draft();
    let version = (await db
      .prepare("SELECT updated_at FROM products WHERE id = ?")
      .bind(id)
      .first<{ updated_at: number }>())!.updated_at;
    for (const [filename, contentType, extension] of [
      ["still-photo.jpg", "image/jpeg", "jpg"],
      ["still-photo.webp", "image/webp", "webp"],
    ] as const) {
      const bytes = readFileSync(resolve("tests/fixtures", filename));
      const uploadId = crypto.randomUUID();
      const saved = await uploadPhoto(
        platform.env,
        id,
        await request(uploadId, version, bytes, undefined, contentType),
      );
      version = saved.version;
      const original = await platform.env.PRODUCT_IMAGES.get(
        `products/${id}/${uploadId}.${extension}`,
      );
      expect(Buffer.from(await original!.arrayBuffer())).toEqual(bytes);
    }
    expect(await listAdminPhotos(db, id)).toHaveLength(2);
  });
  it("returns the current photo version after a lost response and a later photo edit", async () => {
    const id = await draft();
    const version = (await db
      .prepare("SELECT updated_at FROM products WHERE id = ?")
      .bind(id)
      .first<{ updated_at: number }>())!.updated_at;
    const uploadId = crypto.randomUUID();
    const uploaded = await uploadPhoto(
      platform.env,
      id,
      await request(uploadId, version),
    );
    const later = await editPhotoAlt(
      db,
      id,
      uploaded.photos[0].id,
      uploaded.version,
      "Later description",
    );
    const retry = await uploadPhoto(
      platform.env,
      id,
      await request(uploadId, version),
    );
    expect(retry.version).toBe(later.version);
    expect(retry.businessVersion).toBe(uploaded.businessVersion);
    expect(retry.photos).toHaveLength(1);
  });
  it("reports a changed business revision on a committed retry after another tab edits product fields", async () => {
    const id = await draft();
    const version = (await db
      .prepare("SELECT updated_at FROM products WHERE id = ?")
      .bind(id)
      .first<{ updated_at: number }>())!.updated_at;
    const uploadId = crypto.randomUUID();
    const uploaded = await uploadPhoto(
      platform.env,
      id,
      await request(uploadId, version),
    );
    const businessVersion = await changeProduct(
      platform.env,
      id,
      uploaded.version,
      "save",
      { ...fields, name: "Changed elsewhere" },
    );
    const retry = await uploadPhoto(
      platform.env,
      id,
      await request(uploadId, version),
    );
    expect(retry.version).toBe(businessVersion);
    expect(retry.businessVersion).toBe(businessVersion);
    expect(retry.businessVersion).not.toBe(uploaded.businessVersion);
    await expect(
      changeProduct(platform.env, id, uploaded.version, "save", {
        ...fields,
        name: "Unsaved first-tab edit",
      }),
    ).rejects.toThrow(/changed/);
  });
  it("keeps unique orders during swaps and rejects stale concurrent actions", async () => {
    const id = await draft();
    let version = (await db
      .prepare("SELECT updated_at FROM products WHERE id = ?")
      .bind(id)
      .first<{ updated_at: number }>())!.updated_at;
    for (let i = 0; i < 3; i++) {
      const result = await uploadPhoto(
        platform.env,
        id,
        await request(crypto.randomUUID(), version),
      );
      version = result.version;
    }
    const ids = (await listAdminPhotos(db, id)).map((photo) => photo.id);
    const swapped = await reorderPhotos(db, id, version, [
      ids[2],
      ids[0],
      ids[1],
    ]);
    expect(swapped.photos.map((photo) => photo.id)).toEqual([
      ids[2],
      ids[0],
      ids[1],
    ]);
    expect(swapped.photos.map((photo) => photo.sortOrder)).toEqual([0, 1, 2]);
    await expect(
      editPhotoAlt(
        db,
        id,
        ids[0],
        version,
        "Silver ring on a cream background",
      ),
    ).rejects.toThrow(/changed/);
    const edited = await editPhotoAlt(
      db,
      id,
      ids[0],
      swapped.version,
      "Silver ring on a cream background",
    );
    expect(edited.photos.find((photo) => photo.id === ids[0])?.altText).toBe(
      "Silver ring on a cream background",
    );
    const removed = await removePhoto(platform.env, id, ids[1], edited.version);
    expect(removed.photos).toHaveLength(2);
  });
  it("keeps the final public photo and rejects cross-product mutations", async () => {
    const firstId = await draft();
    const secondId = await draft();
    const version = (await db
      .prepare("SELECT updated_at FROM products WHERE id = ?")
      .bind(firstId)
      .first<{ updated_at: number }>())!.updated_at;
    const uploaded = await uploadPhoto(
      platform.env,
      firstId,
      await request(crypto.randomUUID(), version),
    );
    const imageId = uploaded.photos[0].id;
    expect(await adminPhotoSource(db, secondId, imageId)).toBeNull();
    await expect(
      editPhotoAlt(
        db,
        secondId,
        imageId,
        (await db
          .prepare("SELECT updated_at FROM products WHERE id = ?")
          .bind(secondId)
          .first<{ updated_at: number }>())!.updated_at,
        "Wrong product",
      ),
    ).rejects.toThrow(/changed/);
    const publicVersion = await changeProduct(
      platform.env,
      firstId,
      uploaded.version,
      "publish",
      fields,
    );
    await expect(
      removePhoto(platform.env, firstId, imageId, publicVersion),
    ).rejects.toThrow(/last public photo/);
    expect(await listAdminPhotos(db, firstId)).toHaveLength(1);
  });
  it("commits removal when R2 deletion fails and safely reconciles its unreferenced key", async () => {
    const id = await draft();
    const version = (await db
      .prepare("SELECT updated_at FROM products WHERE id = ?")
      .bind(id)
      .first<{ updated_at: number }>())!.updated_at;
    const uploadId = crypto.randomUUID();
    const uploaded = await uploadPhoto(
      platform.env,
      id,
      await request(uploadId, version),
    );
    const key = `products/${id}/${uploadId}.png`;
    const faulted = {
      DB: db,
      IMAGES: platform.env.IMAGES,
      PRODUCT_IMAGES: {
        delete: async () => {
          throw new Error("synthetic delete fault");
        },
      },
    } as unknown as Env;
    const removed = await removePhoto(
      faulted,
      id,
      uploaded.photos[0].id,
      uploaded.version,
    );
    expect(removed.photos).toHaveLength(0);
    expect(await platform.env.PRODUCT_IMAGES.head(key)).not.toBeNull();
    expect(await reconcileRemovedUpload(platform.env, uploadId)).toBe(true);
    expect(await platform.env.PRODUCT_IMAGES.head(key)).toBeNull();
    expect(await reconcileRemovedUpload(platform.env, uploadId)).toBe(true);
  });
  it("recovers a failed R2 put and an R2 object left after a failed D1 batch", async () => {
    const id = await draft();
    let version = (await db
      .prepare("SELECT updated_at FROM products WHERE id = ?")
      .bind(id)
      .first<{ updated_at: number }>())!.updated_at;
    const uploadId = crypto.randomUUID();
    const failedR2 = {
      DB: db,
      IMAGES: platform.env.IMAGES,
      PRODUCT_IMAGES: {
        put: async () => {
          throw new Error("synthetic R2 fault");
        },
      },
    } as unknown as Env;
    await expect(
      uploadPhoto(failedR2, id, await request(uploadId, version)),
    ).rejects.toThrow(/Upload failed/);
    expect(await listAdminPhotos(db, id)).toHaveLength(0);
    const recovered = await uploadPhoto(
      platform.env,
      id,
      await request(uploadId, version),
    );
    expect(recovered.photos).toHaveLength(1);
    version = recovered.version;

    const secondUploadId = crypto.randomUUID();
    const failedD1 = {
      DB: {
        prepare: db.prepare.bind(db),
        batch: async () => {
          throw new Error("synthetic D1 fault");
        },
      },
      IMAGES: platform.env.IMAGES,
      PRODUCT_IMAGES: platform.env.PRODUCT_IMAGES,
    } as unknown as Env;
    await expect(
      uploadPhoto(failedD1, id, await request(secondUploadId, version)),
    ).rejects.toThrow(/synthetic D1 fault/);
    expect(await listAdminPhotos(db, id)).toHaveLength(1);
    const pending = await db
      .prepare(
        "SELECT r2_key FROM product_photo_uploads WHERE upload_id = ? AND state = 'active'",
      )
      .bind(secondUploadId)
      .first<{ r2_key: string }>();
    expect(
      await platform.env.PRODUCT_IMAGES.head(pending!.r2_key),
    ).not.toBeNull();
    const resumed = await uploadPhoto(
      platform.env,
      id,
      await request(secondUploadId, version),
    );
    expect(resumed.photos).toHaveLength(2);
  });
  it("allows one winner when the same upload identity races", async () => {
    const id = await draft();
    const version = (await db
      .prepare("SELECT updated_at FROM products WHERE id = ?")
      .bind(id)
      .first<{ updated_at: number }>())!.updated_at;
    const uploadId = crypto.randomUUID();
    const attempts = await Promise.allSettled([
      uploadPhoto(platform.env, id, await request(uploadId, version)),
      uploadPhoto(platform.env, id, await request(uploadId, version)),
    ]);
    expect(
      attempts.filter((item) => item.status === "fulfilled").length,
    ).toBeGreaterThanOrEqual(1);
    expect(await listAdminPhotos(db, id)).toHaveLength(1);
  });
  it("reports an active writer, then retries immediately after that writer fails", async () => {
    const id = await draft();
    const version = (await db
      .prepare("SELECT updated_at FROM products WHERE id = ?")
      .bind(id)
      .first<{ updated_at: number }>())!.updated_at;
    const uploadId = crypto.randomUUID();
    let entered!: () => void;
    let fail!: () => void;
    const atWrite = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      fail = resolve;
    });
    const interruptedEnv = {
      DB: db,
      IMAGES: platform.env.IMAGES,
      PRODUCT_IMAGES: {
        put: async () => {
          entered();
          await gate;
          throw new Error("interrupted write");
        },
      },
    } as unknown as Env;
    const interrupted = uploadPhoto(
      interruptedEnv,
      id,
      await request(uploadId, version),
    );
    await atWrite;
    await expect(
      uploadPhoto(platform.env, id, await request(uploadId, version)),
    ).rejects.toMatchObject({ code: "upload_in_progress" });
    fail();
    await expect(interrupted).rejects.toThrow(/Upload failed/);
    const recovered = await uploadPhoto(
      platform.env,
      id,
      await request(uploadId, version),
    );
    expect(recovered.photos).toHaveLength(1);
    const key = `products/${id}/${uploadId}.png`;
    expect(
      Buffer.from(
        await (await platform.env.PRODUCT_IMAGES.get(key))!.arrayBuffer(),
      ),
    ).toEqual(png);
    expect(
      (
        await db
          .prepare(
            "SELECT COUNT(*) AS count FROM product_images WHERE upload_id = ?",
          )
          .bind(uploadId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
  });
  it("keeps one immutable original when a retry takes over an expired writer lease", async () => {
    const id = await draft();
    const version = (await db
      .prepare("SELECT updated_at FROM products WHERE id = ?")
      .bind(id)
      .first<{ updated_at: number }>())!.updated_at;
    const uploadId = crypto.randomUUID();
    const key = `products/${id}/${uploadId}.png`;
    let entered!: () => void;
    let release!: () => void;
    const atWrite = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const heldEnv = {
      DB: db,
      IMAGES: platform.env.IMAGES,
      PRODUCT_IMAGES: {
        put: async (...args: Parameters<R2Bucket["put"]>) => {
          entered();
          await gate;
          return platform.env.PRODUCT_IMAGES.put(...args);
        },
        head: platform.env.PRODUCT_IMAGES.head.bind(
          platform.env.PRODUCT_IMAGES,
        ),
      },
    } as unknown as Env;
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const late = uploadPhoto(heldEnv, id, await request(uploadId, version));
      await atWrite;
      now += 6_000;
      const committed = await uploadPhoto(
        platform.env,
        id,
        await request(uploadId, version),
      );
      expect(committed.photos).toHaveLength(1);
      release();
      await expect(late).rejects.toMatchObject({ code: "stale_product" });
      const rows = await db
        .prepare(
          "SELECT id, r2_key FROM product_images WHERE upload_id = ? AND product_id = ?",
        )
        .bind(uploadId, id)
        .all<{ id: number; r2_key: string }>();
      expect(rows.results).toHaveLength(1);
      expect(rows.results[0].r2_key).toBe(key);
      expect(rows.results[0].id).toBe(committed.photos[0].id);
      const original = await platform.env.PRODUCT_IMAGES.get(key);
      expect(Buffer.from(await original!.arrayBuffer())).toEqual(png);
    } finally {
      release();
      clock.mockRestore();
    }
  });
  it("never deletes a committed original when a paused validation later fails", async () => {
    const id = await draft();
    const version = (await db
      .prepare("SELECT updated_at FROM products WHERE id = ?")
      .bind(id)
      .first<{ updated_at: number }>())!.updated_at;
    const uploadId = crypto.randomUUID();
    const key = `products/${id}/${uploadId}.png`;
    let entered!: () => void;
    let resume!: () => void;
    const atValidation = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const failingEnv = {
      DB: db,
      PRODUCT_IMAGES: platform.env.PRODUCT_IMAGES,
      IMAGES: {
        info: async () => {
          entered();
          await gate;
          throw new Error("synthetic decode failure");
        },
      },
    } as unknown as Env;
    const failing = uploadPhoto(
      failingEnv,
      id,
      await request(uploadId, version),
    );
    await atValidation;
    const committed = await uploadPhoto(
      platform.env,
      id,
      await request(uploadId, version),
    );
    expect(committed.photos).toHaveLength(1);
    resume();
    await expect(failing).rejects.toThrow(/read this photo/);
    const row = await db
      .prepare(
        "SELECT id FROM product_images WHERE upload_id = ? AND r2_key = ?",
      )
      .bind(uploadId, key)
      .first<{ id: number }>();
    expect(row?.id).toBe(committed.photos[0].id);
    const original = await platform.env.PRODUCT_IMAGES.get(key);
    expect(Buffer.from(await original!.arrayBuffer())).toEqual(png);
    expect(
      (await deliverProductImage(platform.env, id, key, "thumb")).status,
    ).toBe(200);
  });
  it("makes a validation failure terminal before another request can commit the same identity", async () => {
    const id = await draft();
    const version = (await db
      .prepare("SELECT updated_at FROM products WHERE id = ?")
      .bind(id)
      .first<{ updated_at: number }>())!.updated_at;
    const uploadId = crypto.randomUUID();
    let entered!: () => void;
    let resume!: () => void;
    const atValidation = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const failingEnv = {
      DB: db,
      PRODUCT_IMAGES: platform.env.PRODUCT_IMAGES,
      IMAGES: {
        info: async () => {
          entered();
          await gate;
          throw new Error("synthetic decode failure");
        },
      },
    } as unknown as Env;
    const failing = uploadPhoto(
      failingEnv,
      id,
      await request(uploadId, version),
    );
    await atValidation;
    resume();
    await expect(failing).rejects.toThrow(/read this photo/);
    await expect(
      uploadPhoto(platform.env, id, await request(uploadId, version)),
    ).rejects.toThrow(/different file/);
    expect(await listAdminPhotos(db, id)).toHaveLength(0);
    expect(
      await platform.env.PRODUCT_IMAGES.head(`products/${id}/${uploadId}.png`),
    ).toBeNull();
  });
  it("bars a late R2 writer after abandonment and reconciles its unreferenced object", async () => {
    const id = await draft();
    const version = (await db
      .prepare("SELECT updated_at FROM products WHERE id = ?")
      .bind(id)
      .first<{ updated_at: number }>())!.updated_at;
    const uploadId = crypto.randomUUID();
    const key = `products/${id}/${uploadId}.png`;
    let entered!: () => void;
    let resume!: () => void;
    const atWrite = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const lateEnv = {
      DB: db,
      IMAGES: platform.env.IMAGES,
      PRODUCT_IMAGES: {
        put: async (...args: Parameters<R2Bucket["put"]>) => {
          entered();
          await gate;
          return platform.env.PRODUCT_IMAGES.put(...args);
        },
        head: platform.env.PRODUCT_IMAGES.head.bind(
          platform.env.PRODUCT_IMAGES,
        ),
        delete: platform.env.PRODUCT_IMAGES.delete.bind(
          platform.env.PRODUCT_IMAGES,
        ),
      },
    } as unknown as Env;
    const late = uploadPhoto(lateEnv, id, await request(uploadId, version));
    await atWrite;
    expect(
      await abandonStaleUpload(platform.env, uploadId, Date.now() + 6_000),
    ).toBe(true);
    resume();
    await expect(late).rejects.toThrow(/changed/);
    expect(await listAdminPhotos(db, id)).toHaveLength(0);
    expect(await platform.env.PRODUCT_IMAGES.head(key)).not.toBeNull();
    expect(
      await reconcileAbandonedUpload(
        platform.env,
        uploadId,
        Date.now() + 20 * 60_000,
      ),
    ).toBe(true);
    expect(await platform.env.PRODUCT_IMAGES.head(key)).toBeNull();
  });
  it("rejects mismatched, corrupt, empty, and animated files before creating an image row", async () => {
    const id = await draft();
    const version = (await db
      .prepare("SELECT updated_at FROM products WHERE id = ?")
      .bind(id)
      .first<{ updated_at: number }>())!.updated_at;
    await expect(
      uploadPhoto(
        platform.env,
        id,
        await request(
          crypto.randomUUID(),
          version,
          png,
          undefined,
          "image/webp",
        ),
      ),
    ).rejects.toThrow(/format/);
    await expect(
      uploadPhoto(
        platform.env,
        id,
        await request(
          crypto.randomUUID(),
          version,
          Buffer.from("not an image"),
        ),
      ),
    ).rejects.toThrow(/JPEG, PNG/);
    const corrupted = Buffer.from(png);
    corrupted[corrupted.length - 20] ^= 255;
    await expect(
      uploadPhoto(
        platform.env,
        id,
        await request(crypto.randomUUID(), version, corrupted),
      ),
    ).rejects.toThrow(/read this photo/);
    for (const [filename, type] of [
      ["animated-photo.png", "image/png"],
      ["animated-photo.webp", "image/webp"],
    ] as const) {
      const bytes = readFileSync(resolve("tests/fixtures", filename));
      await expect(
        uploadPhoto(
          platform.env,
          id,
          await request(crypto.randomUUID(), version, bytes, undefined, type),
        ),
      ).rejects.toThrow(/Animated/);
    }
    expect(await listAdminPhotos(db, id)).toHaveLength(0);
  });
  it("keeps abandoned identities terminal and removes a late unreferenced object on a second sweep", async () => {
    const id = await draft();
    const version = (await db
      .prepare("SELECT updated_at FROM products WHERE id = ?")
      .bind(id)
      .first<{ updated_at: number }>())!.updated_at;
    const uploadId = crypto.randomUUID();
    const failedD1 = {
      DB: {
        prepare: db.prepare.bind(db),
        batch: async () => {
          throw new Error("synthetic D1 fault");
        },
      },
      IMAGES: platform.env.IMAGES,
      PRODUCT_IMAGES: platform.env.PRODUCT_IMAGES,
    } as unknown as Env;
    await expect(
      uploadPhoto(failedD1, id, await request(uploadId, version)),
    ).rejects.toThrow();
    const key = `products/${id}/${uploadId}.png`;
    await db
      .prepare(
        "UPDATE product_photo_uploads SET lease_until = 0 WHERE upload_id = ?",
      )
      .bind(uploadId)
      .run();
    expect(await abandonStaleUpload(platform.env, uploadId)).toBe(true);
    expect(await platform.env.PRODUCT_IMAGES.head(key)).toBeNull();
    await platform.env.PRODUCT_IMAGES.put(key, png, {
      httpMetadata: { contentType: "image/png" },
    });
    expect(await reconcileAbandonedUpload(platform.env, uploadId)).toBe(true);
    expect(await platform.env.PRODUCT_IMAGES.head(key)).toBeNull();
    await expect(
      uploadPhoto(platform.env, id, await request(uploadId, version)),
    ).rejects.toThrow(/different file/);
  });
});
