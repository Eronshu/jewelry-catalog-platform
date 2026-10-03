import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RouterContextProvider } from "react-router";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cloudflareContext } from "../cloudflare-context";
import { adminPrincipalContext } from "../lib/auth/admin-access.server";
import { editPhotoAlt } from "../lib/db/admin-product-photos.server";
import {
  changeProduct,
  createDraft,
  type ProductFields,
} from "../lib/db/admin-products.server";
import { action } from "./admin-product-photo-upload";
import { action as createAction } from "./admin-product-create";
import {
  action as reorderAction,
  loader as photoListLoader,
} from "./admin-product-photos";

const root = resolve(process.cwd());
const png = readFileSync(resolve("tests/fixtures/still-photo.png"));
const fields: ProductFields = {
  name: "Route test ring",
  price: "29.95",
  categoryId: "4",
  material: "",
  colour: "",
  description: "",
  sku: "",
  quantity: "",
  facebookUrl: "",
};
let localDir: string;
let platform: PlatformProxy<Env>;
let db: D1Database;
beforeAll(async () => {
  localDir = mkdtempSync(join(tmpdir(), "jewelry-photo-route-test-"));
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

async function product() {
  const id = await createDraft(db, fields, crypto.randomUUID());
  const row = await db
    .prepare("SELECT updated_at FROM products WHERE id = ?")
    .bind(id)
    .first<{ updated_at: number }>();
  return { id, version: row!.updated_at };
}
async function createRequest(
  intent: "create" | "lookup",
  key: string,
  name = fields.name,
) {
  const context = new RouterContextProvider();
  context.set(adminPrincipalContext, {
    email: "owner@example.invalid",
    sub: "route-test",
  });
  context.set(cloudflareContext, {
    env: platform.env,
    ctx: {} as ExecutionContext,
  });
  const body = new URLSearchParams({
    ...fields,
    name,
    requestKey: key,
    intent,
  });
  return await createAction({
    context,
    request: new Request("https://example.invalid/admin/products/new/create", {
      method: "POST",
      headers: {
        Origin: "https://example.invalid",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    }),
  } as unknown as Parameters<typeof createAction>[0]);
}

describe("protected non-navigating Draft creation", () => {
  it("returns one Draft for an identical retry, rejects key reuse with changed fields, and looks up current version", async () => {
    const key = crypto.randomUUID();
    const first = (await createRequest("create", key)) as {
      data: { product?: { id: number; version: number } };
      init?: { status?: number; headers?: HeadersInit };
    };
    const id = first.data.product?.id;
    expect(id).toBeTypeOf("number");
    expect(new Headers(first.init?.headers).get("Cache-Control")).toBe(
      "private, no-store",
    );
    const retry = (await createRequest("create", key)) as typeof first;
    expect(retry.data.product?.id).toBe(id);
    const changed = (await createRequest("create", key, "Changed ring")) as {
      init?: { status?: number };
    };
    expect(changed.init?.status).toBe(409);
    await db
      .prepare("UPDATE products SET updated_at = updated_at + 1 WHERE id = ?")
      .bind(id)
      .run();
    const lookup = (await createRequest("lookup", key)) as typeof first;
    expect(lookup.data.product?.id).toBe(id);
    expect(lookup.data.product?.version).toBe(first.data.product!.version + 1);
    const count = await db
      .prepare(
        "SELECT COUNT(*) AS count FROM products WHERE creation_request_key = ?",
      )
      .bind(key)
      .first<{ count: number }>();
    expect(count?.count).toBe(1);
  });
});
async function upload(
  id: number,
  version: number,
  uploadId: string,
  bytes: Uint8Array,
  declaredLength?: number,
  uploadEnv: Env = platform.env,
) {
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  const context = new RouterContextProvider();
  context.set(adminPrincipalContext, {
    email: "owner@example.invalid",
    sub: "route-test",
  });
  context.set(cloudflareContext, {
    env: uploadEnv,
    ctx: {} as ExecutionContext,
  });
  const response = await action({
    request: new Request(
      `https://example.invalid/admin/products/${id}/photos/upload`,
      {
        method: "POST",
        headers: {
          Origin: "https://example.invalid",
          "Content-Type": "image/png",
          "X-Upload-Id": uploadId,
          "X-Photo-Sha256": hash,
          "X-Product-Version": String(version),
          ...(declaredLength === undefined
            ? {}
            : { "Content-Length": String(declaredLength) }),
        },
        body: Uint8Array.from(bytes),
      },
    ),
    context,
    params: { productId: String(id) },
  } as unknown as Parameters<typeof action>[0]);
  return response as {
    data: {
      version?: number;
      photos?: unknown[];
      error?: string;
      code?: string;
    };
    init?: { status?: number; headers?: HeadersInit };
  };
}

describe("photo upload route length and reservation handling", () => {
  it("accepts an upload and identical retry without Content-Length", async () => {
    const { id, version } = await product();
    const uploadId = crypto.randomUUID();
    const first = await upload(id, version, uploadId, png);
    expect(first.init?.status ?? 200).toBe(200);
    expect(first.data.photos).toHaveLength(1);
    const retry = await upload(id, version, uploadId, png);
    expect(retry.init?.status ?? 200).toBe(200);
    expect(retry.data.version).toBe(first.data.version);
    expect(retry.data.photos).toHaveLength(1);
  });
  it.each([png.length - 1, png.length + 1])(
    "rejects a contradictory declared length of %i",
    async (declaredLength) => {
      const { id, version } = await product();
      const reply = await upload(
        id,
        version,
        crypto.randomUUID(),
        png,
        declaredLength,
      );
      expect(reply.init?.status).toBe(400);
      expect(reply.data.error).toMatch(/incomplete/);
      const rows = await db
        .prepare(
          "SELECT COUNT(*) AS count FROM product_images WHERE product_id = ?",
        )
        .bind(id)
        .first<{ count: number }>();
      expect(rows?.count).toBe(0);
    },
  );
  it("bounds actual bytes without Content-Length", async () => {
    const { id, version } = await product();
    const oversized = new Uint8Array(18_000_001);
    oversized.set(png.subarray(0, 16));
    const reply = await upload(id, version, crypto.randomUUID(), oversized);
    expect(reply.init?.status).toBe(413);
    expect(reply.data.error).toMatch(/too large/);
  });
  it("recovers a failed first write through a normal route retry and later business save", async () => {
    const { id, version } = await product();
    const uploadId = crypto.randomUUID();
    const failingEnv = {
      DB: db,
      IMAGES: platform.env.IMAGES,
      PRODUCT_IMAGES: {
        put: async () => {
          throw new Error("interrupted first write");
        },
      },
    } as unknown as Env;
    const failed = await upload(
      id,
      version,
      uploadId,
      png,
      undefined,
      failingEnv,
    );
    expect(failed.init?.status).toBe(503);
    expect(failed.data.error).toMatch(/Retry this photo/);
    const retry = await upload(id, version, uploadId, png);
    expect(retry.init?.status ?? 200).toBe(200);
    expect(retry.data.photos).toHaveLength(1);
    const key = `products/${id}/${uploadId}.png`;
    const stored = await platform.env.PRODUCT_IMAGES.get(key);
    expect(Buffer.from(await stored!.arrayBuffer())).toEqual(png);
    const objects = await platform.env.PRODUCT_IMAGES.list({
      prefix: `products/${id}/`,
    });
    expect(
      objects.objects
        .filter((object) => object.key.includes(uploadId))
        .map((object) => object.key),
    ).toEqual([key]);
    const rows = await db
      .prepare(
        "SELECT COUNT(*) AS count FROM product_images WHERE upload_id = ?",
      )
      .bind(uploadId)
      .first<{ count: number }>();
    expect(rows?.count).toBe(1);
    await expect(
      changeProduct(platform.env, id, retry.data.version!, "save", {
        ...fields,
        name: "Saved after retry",
      }),
    ).resolves.toBeGreaterThan(retry.data.version!);
  });
});

it("returns a structured stale reorder conflict, then accepts the refreshed order", async () => {
  const { id, version } = await product();
  const first = await upload(id, version, crypto.randomUUID(), png);
  const second = await upload(
    id,
    first.data.version!,
    crypto.randomUUID(),
    png,
  );
  const ids = (second.data.photos as Array<{ id: number }>).map(
    (photo) => photo.id,
  );
  const elsewhere = await editPhotoAlt(
    db,
    id,
    ids[0],
    second.data.version!,
    "Changed elsewhere",
  );
  const context = new RouterContextProvider();
  context.set(adminPrincipalContext, {
    email: "owner@example.invalid",
    sub: "route-test",
  });
  context.set(cloudflareContext, {
    env: platform.env,
    ctx: {} as ExecutionContext,
  });
  async function reorder(expectedVersion: number) {
    return (await reorderAction({
      request: new Request(
        `https://example.invalid/admin/products/${id}/photos`,
        {
          method: "POST",
          headers: {
            Origin: "https://example.invalid",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            intent: "reorder",
            version: String(expectedVersion),
            order: [...ids].reverse().join(","),
          }),
        },
      ),
      context,
      params: { productId: String(id) },
    } as unknown as Parameters<typeof reorderAction>[0])) as {
      data: { code?: string; version?: number; photos?: Array<{ id: number }> };
      init?: { status?: number; headers?: HeadersInit };
    };
  }
  const stale = await reorder(second.data.version!);
  expect(stale.init?.status).toBe(409);
  expect(stale.data.code).toBe("stale_product");
  const refreshed = (await photoListLoader({
    context,
    params: { productId: String(id) },
  } as unknown as Parameters<typeof photoListLoader>[0])) as {
    data: { version: number; photos: Array<{ id: number }> };
  };
  expect(refreshed.data.version).toBe(elsewhere.version);
  expect(refreshed.data.photos.map((photo) => photo.id)).toEqual(ids);
  const retried = await reorder(refreshed.data.version);
  expect(retried.init?.status ?? 200).toBe(200);
  expect(retried.data.photos?.map((photo) => photo.id)).toEqual(
    [...ids].reverse(),
  );
});
