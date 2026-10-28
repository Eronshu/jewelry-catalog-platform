import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { isAdminPath } from "../app/lib/admin-path";

interface DatabaseBinding {
  binding: string;
  database_name: string;
  database_id?: string;
  migrations_dir: string;
  migrations_table: string;
}

interface BucketBinding {
  binding: string;
  bucket_name: string;
}

interface Config {
  vars?: Record<string, unknown>;
  assets?: { run_worker_first: string[] };
  images?: { binding: string };
  d1_databases: DatabaseBinding[];
  r2_buckets?: BucketBinding[];
  previews?: {
    vars?: Record<string, unknown>;
    images: { binding: string };
    d1_databases: DatabaseBinding[];
    r2_buckets: BucketBinding[];
  };
}

function readConfig(filename: string): Config {
  // These committed JSONC files contain trailing commas but no comments.
  const source = readFileSync(resolve(filename), "utf8");
  return JSON.parse(source.replace(/,(\s*[}\]])/g, "$1")) as Config;
}

function matches(pattern: string, pathname: string): boolean {
  return pattern.endsWith("/*")
    ? pathname.startsWith(pattern.slice(0, -1))
    : pathname === pattern;
}

describe("Preview configuration safety", () => {
  const worker = readConfig("wrangler.jsonc");
  const migration = readConfig("wrangler.preview-migrations.jsonc");

  it("does not enable commerce or ship a local task capability in catalog deployment settings", () => {
    for (const config of [worker, worker.previews, migration]) {
      const vars = config?.vars ?? {};
      expect(vars).not.toHaveProperty("COMMERCE_MODE");
      expect(vars).not.toHaveProperty("COMMERCE_LOCAL_EXPIRY_TOKEN");
    }
  });

  it("keeps local bindings separate and Preview identifiers consistently resolved", () => {
    expect(worker.d1_databases).toHaveLength(1);
    expect(worker.r2_buckets).toHaveLength(1);
    expect(worker.previews?.d1_databases).toHaveLength(1);
    expect(worker.previews?.r2_buckets).toHaveLength(1);
    expect(migration.d1_databases).toHaveLength(1);

    const localDb = worker.d1_databases[0];
    const localBucket = worker.r2_buckets![0];
    const previewDb = worker.previews!.d1_databases[0];
    const previewBucket = worker.previews!.r2_buckets[0];
    const migrationDb = migration.d1_databases[0];

    expect(localDb.binding).toBe("DB");
    expect(localDb.database_id).toBeUndefined();
    expect(localBucket.binding).toBe("PRODUCT_IMAGES");
    expect(localBucket.bucket_name).toBe("jewelry-catalog-images-local");
    expect(previewDb.binding).toBe("DB");
    expect(previewBucket.binding).toBe("PRODUCT_IMAGES");
    expect(migrationDb.binding).toBe("PREVIEW_DB");
    expect(worker.previews!.images.binding).toBe("IMAGES");

    const identifiers = [
      previewDb.database_name,
      previewDb.database_id,
      previewBucket.bucket_name,
    ];
    const replacementMarkers = identifiers.map((identifier) =>
      /^replace[-_]/i.test(identifier ?? ""),
    );
    expect(identifiers.every((identifier) => identifier?.trim())).toBe(true);
    expect(
      replacementMarkers.every(Boolean) ||
        replacementMarkers.every((marked) => !marked),
    ).toBe(true);

    expect(previewDb.database_name).not.toBe(localDb.database_name);
    expect(previewBucket.bucket_name).not.toBe(localBucket.bucket_name);
    expect(migrationDb).toEqual({
      ...previewDb,
      binding: "PREVIEW_DB",
    });
  });

  it("routes canonical Admin documents, data, actions, uploads and previews through the Worker", () => {
    const patterns = worker.assets!.run_worker_first;
    expect(patterns).toEqual(["/admin", "/admin.data", "/admin/*"]);

    for (const path of [
      "/admin",
      "/admin.data",
      "/admin/products",
      "/admin/products.data",
      "/admin/products/new.data",
      "/admin/products/new/create",
      "/admin/products/17/edit.data",
      "/admin/products/17/photos",
      "/admin/products/17/photos/upload",
      "/admin/products/17/photos/2",
      "/admin/products/17/photos/2/preview",
    ]) {
      expect(isAdminPath(path), path).toBe(true);
      expect(
        patterns.some((pattern) => matches(pattern, path)),
        path,
      ).toBe(true);
    }
    expect(patterns.some((pattern) => matches(pattern, "/shop"))).toBe(false);
  });

  it("guards alternate Admin spellings at the Worker boundary", () => {
    for (const path of [
      "/Admin",
      "/ADMIN.DATA",
      "/%61dmin",
      "/%41dmin.data",
      "/admin%2fproducts%2f17%2fphotos%2fupload",
      "/ADMIN/products/17/photos/2/preview",
    ]) {
      expect(isAdminPath(path), path).toBe(true);
    }
  });
});
