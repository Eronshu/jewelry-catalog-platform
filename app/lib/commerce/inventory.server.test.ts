import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyStockCommand, listCommerceVariants } from "./inventory.server";

const root = resolve(process.cwd());
let localDir: string;
let platform: PlatformProxy<Env>;
let db: D1Database;
let sequence = 0;
const id = (prefix: string) => `${prefix}-${++sequence}`;
async function variant(quantity = 5) {
  const variantId = id("variant");
  const product = await db
    .prepare(
      `INSERT INTO products(name, slug, price_cents, quantity, category_id, status, created_at, updated_at)
    VALUES ('Fictional necklace', ?, 999, 999, 1, 'draft', 1, 1) RETURNING id`,
    )
    .bind(variantId)
    .first<{ id: number }>();
  await db.batch([
    db
      .prepare(
        "INSERT INTO product_images(product_id, r2_key, sort_order, created_at) VALUES (?, ?, 0, 1)",
      )
      .bind(product!.id, `fake/${variantId}.jpg`),
    db
      .prepare("UPDATE products SET status = 'available' WHERE id = ?")
      .bind(product!.id),
    db
      .prepare(
        `INSERT INTO commerce_variants(id, product_id, sku, colour, size_description, price_cents, active) VALUES (?, ?, ?, 'Gold-tone', 'One size - fictional sample', 2500, 1)`,
      )
      .bind(variantId, product!.id, variantId),
  ]);
  if (quantity)
    await applyStockCommand(db, id("receive"), [
      {
        variantId,
        kind: "receive",
        quantity,
        reason: "Fictional test receipt",
      },
    ]);
  return { variantId, productId: product!.id };
}
async function balance(variantId: string) {
  return db
    .prepare(
      "SELECT on_hand, facebook_reserved, checkout_reserved, allocated FROM commerce_inventory WHERE variant_id = ?",
    )
    .bind(variantId)
    .first();
}
beforeAll(async () => {
  localDir = mkdtempSync(join(tmpdir(), "jewelry-commerce-stock-"));
  execFileSync(
    join(root, "node_modules/.bin/wrangler"),
    ["d1", "migrations", "apply", "DB", "--local", "--persist-to", localDir],
    {
      cwd: root,
      env: {
        ...process.env,
        CI: "1",
        WRANGLER_SEND_METRICS: "false",
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
}, 30000);
afterAll(async () => {
  await platform?.dispose();
  if (localDir) rmSync(localDir, { recursive: true, force: true });
});

describe("isolated commerce stock on migrated D1", () => {
  it("keeps one Facebook unit separate and never automatically replenishes it", async () => {
    const { variantId } = await variant();
    await applyStockCommand(db, id("fbhold"), [
      { variantId, kind: "fb_reserve", quantity: 1, reason: "Facebook shelf" },
    ]);
    expect(
      (await listCommerceVariants(db)).find((v) => v.id === variantId)
        ?.available,
    ).toBe(4);
    const command = id("fbsale");
    const changes = [
      {
        variantId,
        kind: "fb_sale" as const,
        quantity: 1,
        reason: "Facebook sale",
      },
    ];
    await applyStockCommand(db, command, changes);
    expect(await applyStockCommand(db, command, changes)).toEqual({
      replayed: true,
    });
    expect(await balance(variantId)).toEqual({
      on_hand: 4,
      facebook_reserved: 0,
      checkout_reserved: 0,
      allocated: 0,
    });
    expect(
      (await listCommerceVariants(db)).find((v) => v.id === variantId)
        ?.available,
    ).toBe(4);
    await expect(
      applyStockCommand(db, command, [{ ...changes[0], quantity: 2 }]),
    ).rejects.toMatchObject({ code: "command_conflict" });
  });
  it("rolls back the command and first line when a later line lacks stock", async () => {
    const a = await variant(2);
    const b = await variant(0);
    const command = id("cart");
    await expect(
      applyStockCommand(
        db,
        command,
        [a, b].map(({ variantId }) => ({
          variantId,
          kind: "reserve",
          quantity: 1,
          expectedVersion: 1,
          reason: "Test checkout",
        })),
      ),
    ).rejects.toMatchObject({ code: "stock_conflict" });
    expect((await balance(a.variantId))?.checkout_reserved).toBe(0);
    expect(
      await db
        .prepare("SELECT id FROM commerce_commands WHERE id = ?")
        .bind(command)
        .first(),
    ).toBeNull();
    expect(
      (
        await db
          .prepare(
            "SELECT COUNT(*) AS n FROM commerce_stock_movements WHERE command_id = ?",
          )
          .bind(command)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });
  it("serializes competing checkout and Facebook requests for the last unit", async () => {
    const { variantId } = await variant(1);
    const results = await Promise.allSettled([
      applyStockCommand(db, id("web"), [
        {
          variantId,
          kind: "reserve",
          quantity: 1,
          expectedVersion: 1,
          reason: "Web",
        },
      ]),
      applyStockCommand(db, id("fb"), [
        { variantId, kind: "fb_reserve", quantity: 1, reason: "Facebook" },
      ]),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const stock = await balance(variantId);
    expect(
      Number(stock?.facebook_reserved) + Number(stock?.checkout_reserved),
    ).toBe(1);
  });
  it("rejects missing, unpublished, inactive or changed-price variants in the transaction", async () => {
    const a = await variant(1);
    const b = await variant(1);
    await db
      .prepare("UPDATE products SET status = 'hidden' WHERE id = ?")
      .bind(b.productId)
      .run();
    await expect(
      applyStockCommand(
        db,
        id("hidden"),
        [a, b].map(({ variantId }) => ({
          variantId,
          kind: "reserve",
          quantity: 1,
          expectedVersion: 1,
          reason: "Web",
        })),
      ),
    ).rejects.toMatchObject({ code: "stock_conflict" });
    expect((await balance(a.variantId))?.checkout_reserved).toBe(0);
    await db
      .prepare(
        "UPDATE commerce_variants SET price_cents = 2600, version = 2 WHERE id = ?",
      )
      .bind(a.variantId)
      .run();
    await expect(
      applyStockCommand(db, id("changed"), [
        {
          variantId: a.variantId,
          kind: "reserve",
          quantity: 1,
          expectedVersion: 1,
          reason: "Web",
        },
      ]),
    ).rejects.toMatchObject({ code: "stock_conflict" });
    await expect(
      applyStockCommand(db, id("missing"), [
        {
          variantId: "missing",
          kind: "receive",
          quantity: 1,
          reason: "Receipt",
        },
      ]),
    ).rejects.toMatchObject({ code: "stock_conflict" });
    await db
      .prepare(
        "UPDATE commerce_variants SET active = 0, version = 3 WHERE id = ?",
      )
      .bind(a.variantId)
      .run();
    await expect(
      applyStockCommand(db, id("inactive"), [
        {
          variantId: a.variantId,
          kind: "reserve",
          quantity: 1,
          expectedVersion: 3,
          reason: "Web",
        },
      ]),
    ).rejects.toMatchObject({ code: "stock_conflict" });
  });
  it("does not use legacy quantity or permit legacy price/stock edits for enabled variants", async () => {
    const { variantId, productId } = await variant(0);
    expect(
      (await listCommerceVariants(db)).find((v) => v.id === variantId),
    ).toMatchObject({ available: 0, priceCents: 2500 });
    for (const sql of [
      "UPDATE products SET quantity = 1000 WHERE id = ?",
      "UPDATE products SET price_cents = 1 WHERE id = ?",
    ]) {
      await expect(db.prepare(sql).bind(productId).run()).rejects.toThrow();
    }
    await expect(
      db
        .prepare("UPDATE commerce_variants SET price_cents = 2 WHERE id = ?")
        .bind(variantId)
        .run(),
    ).rejects.toThrow();
  });
  it("concurrent identical commands commit once and audit records cannot be rewritten", async () => {
    const { variantId } = await variant(0);
    const command = id("receipt");
    const changes = [
      { variantId, kind: "receive" as const, quantity: 3, reason: "Inspected" },
    ];
    await Promise.all([
      applyStockCommand(db, command, changes),
      applyStockCommand(db, command, changes),
    ]);
    expect((await balance(variantId))?.on_hand).toBe(3);
    await expect(
      db
        .prepare("DELETE FROM commerce_stock_movements WHERE command_id = ?")
        .bind(command)
        .run(),
    ).rejects.toThrow();
  });
  it("moves a reservation to an allocation and consumes physical stock only on fulfillment", async () => {
    const { variantId } = await variant(2);
    await applyStockCommand(db, id("reserve"), [
      {
        variantId,
        kind: "reserve",
        quantity: 1,
        expectedVersion: 1,
        reason: "Web",
      },
    ]);
    await applyStockCommand(db, id("allocate"), [
      { variantId, kind: "allocate", quantity: 1, reason: "Verified payment" },
    ]);
    expect(await balance(variantId)).toEqual({
      on_hand: 2,
      facebook_reserved: 0,
      checkout_reserved: 0,
      allocated: 1,
    });
    await applyStockCommand(db, id("ship"), [
      { variantId, kind: "fulfill", quantity: 1, reason: "Handoff" },
    ]);
    expect(await balance(variantId)).toEqual({
      on_hand: 1,
      facebook_reserved: 0,
      checkout_reserved: 0,
      allocated: 0,
    });
    await expect(
      applyStockCommand(db, id("double"), [
        {
          variantId,
          kind: "fulfill",
          quantity: 1,
          reason: "Invalid duplicate",
        },
      ]),
    ).rejects.toMatchObject({ code: "stock_conflict" });
  });
  it("validates malformed commands before writing", async () => {
    const { variantId } = await variant(1);
    for (const quantity of [-1, 0, 0.5, NaN, Infinity, 1000001]) {
      await expect(
        applyStockCommand(db, id("bad"), [
          { variantId, kind: "receive", quantity, reason: "Test" },
        ]),
      ).rejects.toMatchObject({ code: "invalid_command" });
    }
    await expect(applyStockCommand(db, "", [])).rejects.toMatchObject({
      code: "invalid_command",
    });
  });
  it("rejects UPDATE/DELETE/REPLACE of commands and movements without changing balances", async () => {
    const { variantId } = await variant(0);
    const command = id("audit");
    await applyStockCommand(db, command, [
      { variantId, kind: "receive", quantity: 2, reason: "Receipt" },
    ]);
    const before = await balance(variantId);
    for (const sql of [
      "UPDATE commerce_commands SET request_hash = printf('%064d', 1) WHERE id = ?",
      "DELETE FROM commerce_commands WHERE id = ?",
      "INSERT OR REPLACE INTO commerce_commands SELECT id, request_hash, created_at FROM commerce_commands WHERE id = ?",
      "UPDATE commerce_stock_movements SET quantity = 3 WHERE command_id = ?",
      "DELETE FROM commerce_stock_movements WHERE command_id = ?",
      "INSERT OR REPLACE INTO commerce_stock_movements SELECT * FROM commerce_stock_movements WHERE command_id = ?",
    ]) {
      await expect(db.prepare(sql).bind(command).run()).rejects.toThrow();
      expect(await balance(variantId)).toEqual(before);
    }
  });
  it("releases only existing holds, rejecting excess release atomically", async () => {
    const { variantId } = await variant(4);
    await applyStockCommand(db, id("hold"), [
      { variantId, kind: "fb_reserve", quantity: 1, reason: "FB" },
      {
        variantId,
        kind: "reserve",
        quantity: 2,
        expectedVersion: 1,
        reason: "Web",
      },
    ]);
    const before = await balance(variantId);
    for (const kind of ["fb_release", "release"] as const) {
      const command = id("overrelease");
      await expect(
        applyStockCommand(db, command, [
          { variantId, kind, quantity: 3, reason: "Invalid" },
        ]),
      ).rejects.toMatchObject({ code: "stock_conflict" });
      expect(await balance(variantId)).toEqual(before);
      expect(
        await db
          .prepare("SELECT id FROM commerce_commands WHERE id = ?")
          .bind(command)
          .first(),
      ).toBeNull();
    }
    await applyStockCommand(db, id("release"), [
      { variantId, kind: "fb_release", quantity: 1, reason: "Return FB shelf" },
      { variantId, kind: "release", quantity: 2, reason: "Unpaid" },
    ]);
    expect(await balance(variantId)).toEqual({
      on_hand: 4,
      facebook_reserved: 0,
      checkout_reserved: 0,
      allocated: 0,
    });
  });
});
