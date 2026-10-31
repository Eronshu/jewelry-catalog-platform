// Each invocation creates new fictional state. Never reads repository env files or remote IDs.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import sharp from "sharp";
import { readPlacesTestSettings } from "./commerce-places-config.mjs";
import { createLocalExpiryDriver } from "./commerce-expiry-driver.mjs";
import { readCommerceLocalPort } from "./commerce-local-config.mjs";
import { readStripeTestSettings } from "./commerce-stripe-config.mjs";
import { readPayPalTestSettings } from "./commerce-paypal-config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.length !== 2)
  throw new Error("No arguments supported: local fictional data only.");
if (!existsSync(join(root, "build/server/index.js")))
  throw new Error("Run npm run build first.");
const port = readCommerceLocalPort(process.env.COMMERCE_LOCAL_PORT);
const directory = mkdtempSync(join(tmpdir(), "jewelry-commerce-local-"));
const places = readPlacesTestSettings(process.env);
const stripe = readStripeTestSettings(process.env, root);
const paypal = readPayPalTestSettings(process.env, root);
const expiryMode = process.env.COMMERCE_EXPIRY_MODE;
if (expiryMode !== undefined && expiryMode !== "local-test")
  throw new Error(
    "COMMERCE_EXPIRY_MODE only accepts local-test; expiry is enabled by default.",
  );
const expiryToken = randomBytes(32).toString("hex");
const checkoutInstance = randomUUID();
const preparationMode = process.env.COMMERCE_LOCAL_PAYMENT_PREPARE;
if (preparationMode !== undefined && preparationMode !== "1")
  throw new Error(
    "COMMERCE_LOCAL_PAYMENT_PREPARE only accepts 1; preparation sends no provider request.",
  );
const preparePayment =
  preparationMode === "1" || stripe !== null || paypal !== null;
const privateSettings = {
  ...places,
  ...stripe,
  ...paypal,
  ...(expiryToken ? { COMMERCE_LOCAL_EXPIRY_TOKEN: expiryToken } : {}),
};
if (Object.keys(privateSettings).length)
  writeFileSync(
    join(directory, ".dev.vars"),
    Object.entries(privateSettings)
      .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
      .join("\n"),
    { mode: 0o600 },
  );
function removeGeneratedPaymentSettings() {
  if (!stripe && !paypal) return;
  try {
    unlinkSync(join(directory, ".dev.vars"));
  } catch {
    // Never report private file contents or provider credentials.
  }
}
process.once("exit", removeGeneratedPaymentSettings);
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
          "/cart",
          "/cart.data",
          "/checkout",
          "/checkout.data",
          "/checkout/*",
          "/commerce-lab",
          "/commerce-lab.data",
          "/_local/commerce/expiry",
          "/admin",
          "/admin.data",
          "/admin/*",
        ],
      },
      vars: {
        COMMERCE_MODE: "local-test",
        COMMERCE_CHECKOUT_INSTANCE_ID: checkoutInstance,
        COMMERCE_CHECKOUT_ORIGIN: `http://127.0.0.1:${port}`,
        COMMERCE_CHECKOUT_EXPIRY: "local-test",
        COMMERCE_CHECKOUT_NEW_ORDERS: "local-test",
        ...(preparePayment
          ? { COMMERCE_CHECKOUT_PAYMENT_PREPARE: "local-test" }
          : {}),
        ...(stripe
          ? {
              COMMERCE_STRIPE_SANDBOX: "local-test",
              COMMERCE_STRIPE_NEW_SESSIONS: "local-test",
            }
          : {}),
        ...(paypal
          ? {
              COMMERCE_PAYPAL_SANDBOX: "local-test",
              COMMERCE_PAYPAL_NEW_ORDERS: "local-test",
              COMMERCE_PAYPAL_CAPTURE: "local-test",
            }
          : {}),
      },
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
function fixtureImageKey(id) {
  return `products/${id}/00000000-0000-4000-8000-${String(id).padStart(12, "0")}.png`;
}
wrangler(["d1", "migrations", "apply", "DB", "--local", "--persist-to", state]);
// Generated fixture illustrations, not merchant photographs or product claims.
for (let id = 1; id <= 3; id++) {
  const image = join(directory, `necklace-${id}.png`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><rect width="640" height="640" fill="#eee8dd"/><path d="M180 150 Q140 440 320 460 Q500 440 460 150" fill="none" stroke="#958473" stroke-width="8"/><circle cx="320" cy="490" r="${18 + id * 8}" fill="none" stroke="#958473" stroke-width="8"/></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(image);
  wrangler([
    "r2",
    "object",
    "put",
    `commerce-fictional-images/${fixtureImageKey(id)}`,
    "--local",
    "--persist-to",
    state,
    "--file",
    image,
    "--content-type",
    "image/png",
  ]);
}
const seed = join(directory, "fictional.sql");
const statements = [];
if (preparePayment)
  statements.push(
    `INSERT INTO commerce_payment_scope(id,mode,instance_id,stripe_account_ref,paypal_account_ref) VALUES (1,'local-test','${checkoutInstance}','fixture-stripe','fixture-paypal');`,
  );
for (const [index, name] of ["Orbit", "Bar", "Pendant"].entries()) {
  const id = index + 1;
  statements.push(
    `INSERT INTO products(id,name,slug,price_cents,quantity,category_id,status,created_at,updated_at) VALUES (${id},'Fictional ${name} necklace','fictional-${index}',2500,0,1,'draft',1,1);`,
  );
  statements.push(
    `INSERT INTO product_images(product_id,r2_key,sort_order,created_at) VALUES (${id},'${fixtureImageKey(id)}',0,1);`,
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
  `Fictional state preserved at: ${directory}\nShopping preview: http://127.0.0.1:${port}/products/fictional-0\nDeveloper lab: http://127.0.0.1:${port}/commerce-lab\nCtrl-C stops the server. A new run creates a new database; no existing data is deleted.`,
);
if (stripe)
  console.log(
    "Stripe Sandbox enabled explicitly: pressing Pay with Stripe will call the test provider. Use fictional orders and provider test cards only. No live payments. The private configuration is not printed.",
  );
if (paypal)
  console.log(
    "PayPal Sandbox enabled explicitly: approval and capture controls can call the test provider. Use fictional orders/test accounts only; configuration is not printed.",
  );
if (preparePayment && !stripe && !paypal)
  console.log(
    "Stripe test preparation enabled: records an intent and protects fictional stock. No provider request or payment is sent; existing attempts cannot use unpaid cancellation/expiry.",
  );
// Validate the driver before starting a child that would otherwise be orphaned.
const expiry = expiryToken
  ? createLocalExpiryDriver({
      origin: `http://127.0.0.1:${port}`,
      token: expiryToken,
    })
  : undefined;
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
    port,
    "--inspector-port",
    "0",
    "--persist-to",
    state,
  ],
  { cwd: directory, env, stdio: "inherit" },
);
expiry?.start();
console.log(
  expiry
    ? "Local expiry enabled: bounded batches every 30s after readiness; see terminal health."
    : "Local expiry unavailable; do not create reservations.",
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    expiry?.stop();
    server.kill(signal);
  });
server.on("exit", (code) => {
  expiry?.stop();
  removeGeneratedPaymentSettings();
  process.exitCode = code ?? 0;
});
