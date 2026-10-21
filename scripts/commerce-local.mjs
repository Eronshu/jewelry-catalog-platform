// Each invocation creates new fictional state. Never reads repository env files or remote IDs.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.length !== 2)
  throw new Error("No arguments supported: local fictional data only.");
if (!existsSync(join(root, "build/server/index.js")))
  throw new Error("Run npm run build first.");
const directory = mkdtempSync(join(tmpdir(), "jewelry-commerce-local-"));
const config = join(directory, "wrangler.json");
const state = join(directory, "state");
writeFileSync(
  config,
  JSON.stringify(
    {
      name: "jewelry-commerce-local-test",
      main: join(root, "build/server/index.js"),
      compatibility_date: "2026-09-29",
      no_bundle: true,
      rules: [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }],
      assets: {
        directory: join(root, "build/client"),
        run_worker_first: [
          "/commerce-lab",
          "/commerce-lab.data",
          "/admin",
          "/admin.data",
          "/admin/*",
        ],
      },
      vars: { COMMERCE_MODE: "local-test" },
      d1_databases: [
        {
          binding: "DB",
          database_name: "commerce-fictional",
          migrations_dir: join(root, "migrations"),
          migrations_table: "catalog_migrations",
        },
      ],
      r2_buckets: [
        { binding: "PRODUCT_IMAGES", bucket_name: "commerce-fictional-images" },
      ],
      images: { binding: "IMAGES" },
    },
    null,
    2,
  ),
);
// Explicit allowlist: no inherited provider/API credentials or dotenv configuration.
const env = {
  PATH: process.env.PATH,
  TMPDIR: tmpdir(),
  XDG_CONFIG_HOME: join(directory, "config"),
  CI: "1",
  WRANGLER_SEND_METRICS: "false",
  WRANGLER_LOG_PATH: join(directory, "wrangler.log"),
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
};
const cli = join(root, "node_modules/wrangler/bin/wrangler.js");
function wrangler(args) {
  execFileSync(process.execPath, [cli, ...args, "--config", config], {
    cwd: directory,
    env,
    stdio: "inherit",
  });
}
wrangler(["d1", "migrations", "apply", "DB", "--local", "--persist-to", state]);
const seed = join(directory, "fictional.sql");
const statements = [];
for (const [index, name] of ["Orbit", "Bar", "Pendant"].entries()) {
  const id = index + 1;
  statements.push(
    `INSERT INTO products(id,name,slug,price_cents,quantity,category_id,status,created_at,updated_at) VALUES (${id},'Fictional ${name} necklace','fictional-${index}',2500,0,1,'draft',1,1);`,
  );
  statements.push(
    `INSERT INTO product_images(product_id,r2_key,sort_order,created_at) VALUES (${id},'fictional/not-an-image-${id}.jpg',0,1);`,
  );
  statements.push(`UPDATE products SET status='available' WHERE id=${id};`);
  for (const [colourIndex, colour] of [
    "Gold-tone",
    "Silver-tone",
    "Black",
  ].entries()) {
    const sku = `test-${id}-${colourIndex}`;
    statements.push(
      `INSERT INTO commerce_variants(id,product_id,sku,colour,size_description,price_cents,active) VALUES ('${sku}',${id},'${sku}','${colour}','Fictional single size; not a product specification',2500,1);`,
    );
    if (colourIndex === 2) continue;
    const command = `seed-${sku}`;
    statements.push(
      `INSERT INTO commerce_commands(id,request_hash,created_at) VALUES ('${command}','${"0".repeat(64)}',1);`,
    );
    statements.push(
      `INSERT INTO commerce_stock_movements(command_id,position,variant_id,kind,quantity,reason) VALUES ('${command}',0,'${sku}','receive',5,'Fictional inspected stock');`,
    );
    if (colourIndex === 0)
      statements.push(
        `INSERT INTO commerce_stock_movements(command_id,position,variant_id,kind,quantity,reason) VALUES ('${command}',1,'${sku}','fb_reserve',1,'Fictional Facebook allocation');`,
      );
  }
}
writeFileSync(seed, statements.join("\n"));
wrangler([
  "d1",
  "execute",
  "DB",
  "--local",
  "--persist-to",
  state,
  "--file",
  seed,
]);
console.log(
  `Fictional state preserved at: ${directory}\nOpen http://127.0.0.1:8791/commerce-lab\nCtrl-C stops the server. A new run creates a new database; no existing data is deleted.`,
);
const server = spawn(
  process.execPath,
  [
    cli,
    "dev",
    "--config",
    config,
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    "8791",
    "--persist-to",
    state,
  ],
  { cwd: directory, env, stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => server.kill(signal));
server.on("exit", (code) => {
  process.exitCode = code ?? 0;
});
