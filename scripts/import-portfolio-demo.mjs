import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(".");
const wrangler = resolve("node_modules/.bin/wrangler");
const output = resolve(".wrangler/portfolio-demo");
const mode = process.argv[2];
if (mode !== "--local" && mode !== "--preview") {
  throw new Error(
    "Choose exactly --local or --preview. Production is unsupported.",
  );
}
const remote = mode === "--preview";
const expectedAccount = process.env.EXPECTED_CF_ACCOUNT_ID;
if (remote && !/^[0-9a-f]{32}$/.test(expectedAccount ?? "")) {
  throw new Error(
    "Set EXPECTED_CF_ACCOUNT_ID to the verified Preview account ID.",
  );
}

async function wranglerCall(args) {
  const result = await run(wrangler, args, {
    cwd: root,
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.stdout;
}

function parseJsonc(text) {
  return JSON.parse(text.replace(/,\s*([}\]])/g, "$1"));
}

const config = parseJsonc(await readFile(resolve("wrangler.jsonc"), "utf8"));
const migrations = parseJsonc(
  await readFile(resolve("wrangler.preview-migrations.jsonc"), "utf8"),
);
const previewDb = config.previews?.d1_databases?.[0];
if (
  previewDb?.binding !== "DB" ||
  previewDb.database_name !== "jewelry-catalog-preview-d1" ||
  previewDb.database_id !== "2a9ffb59-cc54-4c1d-97e8-45ddd8b36aa2" ||
  config.previews?.r2_buckets?.[0]?.binding !== "PRODUCT_IMAGES" ||
  config.previews.r2_buckets[0].bucket_name !==
    "jewelry-catalog-preview-images" ||
  migrations.d1_databases?.[0]?.binding !== "PREVIEW_DB" ||
  migrations.d1_databases[0].database_id !== previewDb.database_id ||
  migrations.d1_databases[0].database_name !== previewDb.database_name
) {
  throw new Error(
    "Preview D1/R2 configuration does not match the reviewed demo targets.",
  );
}

const manifest = JSON.parse(
  await readFile(resolve(output, "manifest.json"), "utf8"),
);
if (
  manifest.count !== 300 ||
  manifest.products.length !== 300 ||
  manifest.products.some(
    (product, index) =>
      product.id !== 500001 + index ||
      product.imageId !== 600001 + index ||
      !product.key.startsWith(`products/${product.id}/`) ||
      product.file !== `images/${product.id}.webp`,
  )
) {
  throw new Error("Generated demo manifest failed the exact-range check.");
}

if (remote) {
  const identity = await wranglerCall(["whoami"]);
  if (!identity.includes(expectedAccount)) {
    throw new Error(
      "Signed-in Cloudflare account does not match EXPECTED_CF_ACCOUNT_ID.",
    );
  }
}

const dbArgs = remote
  ? [
      "d1",
      "execute",
      "PREVIEW_DB",
      "--remote",
      "--config",
      "wrangler.preview-migrations.jsonc",
    ]
  : [
      "d1",
      "execute",
      "DB",
      "--local",
      "--persist-to",
      ".wrangler/portfolio-demo-local",
    ];
const countSql =
  "SELECT (SELECT COUNT(*) FROM products) AS products, " +
  "(SELECT COUNT(*) FROM product_images) AS images, " +
  "(SELECT COUNT(*) FROM product_photo_uploads) AS uploads";
const before = JSON.parse(
  await wranglerCall([...dbArgs, "--command", countSql, "--json"]),
)[0].results[0];
if (before.products !== 0 || before.images !== 0 || before.uploads !== 0) {
  throw new Error(
    "Target catalog is not empty; refusing to mix demo and other data.",
  );
}

const bucket = remote
  ? "jewelry-catalog-preview-images"
  : "jewelry-catalog-images-local";
const r2Mode = remote
  ? ["--remote"]
  : ["--local", "--persist-to", ".wrangler/portfolio-demo-local"];
let cursor = 0;
let completed = 0;
const failures = [];
async function uploadWorker() {
  while (cursor < manifest.products.length) {
    const product = manifest.products[cursor++];
    try {
      await wranglerCall([
        "r2",
        "object",
        "put",
        `${bucket}/${product.key}`,
        "--file",
        resolve(output, product.file),
        "--content-type",
        "image/webp",
        ...r2Mode,
      ]);
      completed++;
      if (completed % 25 === 0) {
        process.stdout.write(`Uploaded ${completed}/300 demo images\n`);
      }
    } catch (error) {
      failures.push({ id: product.id, message: error.message });
    }
  }
}
await Promise.all(Array.from({ length: 6 }, () => uploadWorker()));
if (failures.length) {
  throw new Error(
    `${failures.length} image uploads failed; D1 was not changed. Retry is safe: ${JSON.stringify(failures.slice(0, 3))}`,
  );
}

await wranglerCall([...dbArgs, "--file", resolve(output, "seed.sql"), "--yes"]);
const after = JSON.parse(
  await wranglerCall([...dbArgs, "--command", countSql, "--json"]),
)[0].results[0];
if (after.products !== 300 || after.images !== 300 || after.uploads !== 0) {
  throw new Error(`D1 verification failed: ${JSON.stringify(after)}`);
}
process.stdout.write(
  `Verified 300 fictional products and 300 images in the ${remote ? "Preview" : "local"} demo catalog.\n`,
);
