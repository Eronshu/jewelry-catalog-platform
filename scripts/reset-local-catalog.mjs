import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = join(root, "node_modules", ".bin", "wrangler");
const configPath = join(root, "wrangler.jsonc");
const migrationTable = "catalog_migrations";
const persistTo = process.env.CATALOG_D1_PERSIST_TO;

if (process.argv.length !== 2) {
  throw new Error("This local-only reset does not accept arguments.");
}

const config = readFileSync(configPath, "utf8");
const dbConfig = config.match(/"binding"\s*:\s*"DB"\s*,([^}]*)}/)?.[1];
if (
  !dbConfig ||
  !new RegExp(`"migrations_table"\\s*:\\s*"${migrationTable}"`).test(dbConfig)
) {
  throw new Error("The reset migration ledger differs from wrangler.jsonc.");
}

function localWrangler(args) {
  execFileSync(
    wrangler,
    [...args, "--local", ...(persistTo ? ["--persist-to", persistTo] : [])],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, CI: "1" },
    },
  );
}

// Drop only this D1 database's tables. Other local Cloudflare bindings remain intact.
localWrangler([
  "d1",
  "execute",
  "DB",
  "--command",
  `DROP TABLE IF EXISTS product_images;
   DROP TABLE IF EXISTS products;
   DROP TABLE IF EXISTS categories;
   DROP TABLE IF EXISTS ${migrationTable};`,
]);
localWrangler(["d1", "migrations", "apply", "DB"]);
