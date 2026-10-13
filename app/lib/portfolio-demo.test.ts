import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";

const run = promisify(execFile);
let temporaryRoot: string;

beforeAll(async () => {
  temporaryRoot = await mkdtemp(resolve(tmpdir(), "portfolio-demo-"));
  await run(
    process.execPath,
    [resolve("scripts/generate-portfolio-demo.mjs")],
    { cwd: temporaryRoot, timeout: 60_000 },
  );
}, 65_000);

afterAll(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

it("generates 300 distinct fictional products with deliverable square images", async () => {
  const base = resolve(temporaryRoot, ".wrangler/portfolio-demo");
  const manifest = JSON.parse(
    await readFile(resolve(base, "manifest.json"), "utf8"),
  );
  const files = await readdir(resolve(base, "images"));
  expect(manifest.count).toBe(300);
  expect(files).toHaveLength(300);
  expect(
    new Set(manifest.products.map((product: { slug: string }) => product.slug))
      .size,
  ).toBe(300);
  expect(
    new Set(manifest.products.map((product: { key: string }) => product.key))
      .size,
  ).toBe(300);
  expect(
    manifest.products.every(
      (product: { id: number; key: string; name: string }) =>
        product.name.startsWith("Demo ") &&
        new RegExp(`^products/${product.id}/[0-9a-f-]+\\.webp$`).test(
          product.key,
        ),
    ),
  ).toBe(true);

  const sampleHashes = [];
  for (const index of [0, 74, 75, 149, 150, 224, 225, 299]) {
    const product = manifest.products[index];
    const bytes = await readFile(resolve(base, product.file));
    const metadata = await sharp(bytes).metadata();
    expect(metadata).toMatchObject({ format: "webp", width: 640, height: 640 });
    sampleHashes.push(createHash("sha256").update(bytes).digest("hex"));
  }
  expect(new Set(sampleHashes).size).toBe(sampleHashes.length);
  const newest = [...manifest.products]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 4);
  expect(
    new Set(newest.map((product) => Math.floor((product.id - 500001) / 75)))
      .size,
  ).toBe(4);
});

it("keeps inserts in bounded batches and emits an exact-range rollback", async () => {
  const base = resolve(temporaryRoot, ".wrangler/portfolio-demo");
  const seed = await readFile(resolve(base, "seed.sql"), "utf8");
  const rollback = await readFile(resolve(base, "rollback.sql"), "utf8");
  expect(seed.match(/INSERT INTO products\b/g)).toHaveLength(20);
  expect(seed.match(/INSERT INTO product_images\b/g)).toHaveLength(20);
  expect(seed).toContain("This item is not for sale.");
  expect(seed).toContain("WHERE id BETWEEN 500001 AND 500300");
  expect(rollback).toContain("WHERE id BETWEEN 500001 AND 500300");
  expect(rollback).toContain("slug LIKE 'demo-%'");
});
