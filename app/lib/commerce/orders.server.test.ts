import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyStockCommand } from "./inventory.server";
import {
  createTestQuote,
  getTestOrder,
  listTestOrders,
  releaseTestOrder,
  reserveTestOrder,
} from "./orders.server";

const root = resolve(process.cwd());
const owner = "a".repeat(64);
const otherOwner = "b".repeat(64);
const now = 1_800_000_000_000;
let localDir: string;
let platform: PlatformProxy<Env>;
let db: D1Database;
let sequence = 0;

async function variant(quantity = 3) {
  const variantId = `order-test-${++sequence}`;
  const product = await db
    .prepare(
      `INSERT INTO products(name, slug, price_cents, quantity, category_id, status, created_at, updated_at)
       VALUES ('Fictional order test', ?, 999, 999, 1, 'draft', 1, 1) RETURNING id`,
    )
    .bind(variantId)
    .first<{ id: number }>();
  await db.batch([
    db
      .prepare(
        "INSERT INTO product_images(product_id, r2_key, sort_order, created_at) VALUES (?, ?, 0, 1)",
      )
      .bind(product!.id, `fictional/${variantId}.jpg`),
    db
      .prepare("UPDATE products SET status = 'available' WHERE id = ?")
      .bind(product!.id),
    db
      .prepare(
        `INSERT INTO commerce_variants(id, product_id, sku, colour, size_description, price_cents, active)
         VALUES (?, ?, ?, 'Gold-tone', 'Fictional single size', 2500, 1)`,
      )
      .bind(variantId, product!.id, variantId),
  ]);
  await applyStockCommand(
    db,
    `receipt-${variantId}`,
    [{ variantId, kind: "receive", quantity, reason: "Fictional receipt" }],
    now,
  );
  return { variantId, productId: product!.id };
}

async function balance(variantId: string) {
  return db
    .prepare(
      "SELECT on_hand, facebook_reserved, checkout_reserved, allocated FROM commerce_inventory WHERE variant_id = ?",
    )
    .bind(variantId)
    .first<{
      on_hand: number;
      facebook_reserved: number;
      checkout_reserved: number;
      allocated: number;
    }>();
}

async function count(sql: string, value: string) {
  const result = await db.prepare(sql).bind(value).first<{ n: number }>();
  return result!.n;
}

async function quoted(quantity = 1, stock = 3, customer = owner) {
  const item = await variant(stock);
  const saved = await createTestQuote(
    db,
    customer,
    [{ variantId: item.variantId, quantity }],
    "pickup",
    now,
  );
  return { ...item, ...saved };
}

beforeAll(async () => {
  localDir = mkdtempSync(join(tmpdir(), "jewelry-orders-review-"));
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
}, 30_000);

afterAll(async () => {
  await platform?.dispose();
  if (localDir) rmSync(localDir, { recursive: true, force: true });
});

describe("persistent test quotes and order-owned reservations on real local D1", () => {
  it("persists test-only quotes without reserving stock or trusting legacy price", async () => {
    const saved = await quoted(2);
    expect(saved.quote).toMatchObject({
      testOnly: true,
      currency: "CAD",
      subtotalCents: 5000,
      totalCents: 5000,
    });
    expect(await balance(saved.variantId)).toEqual({
      on_hand: 3,
      facebook_reserved: 0,
      checkout_reserved: 0,
      allocated: 0,
    });
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM commerce_orders WHERE quote_id = ?",
        saved.id,
      ),
    ).toBe(0);
    const persisted = await db
      .prepare("SELECT snapshot FROM commerce_quotes WHERE id = ?")
      .bind(saved.id)
      .first<{ snapshot: string }>();
    expect(JSON.parse(persisted!.snapshot)).toEqual(saved.quote);
  });

  it("reserves every cart line and preserves the accepted snapshot", async () => {
    const a = await variant(3);
    const b = await variant(2);
    const saved = await createTestQuote(
      db,
      owner,
      [
        { variantId: a.variantId, quantity: 2 },
        { variantId: b.variantId, quantity: 1 },
      ],
      "shipping",
      now,
    );
    const order = await reserveTestOrder(db, owner, saved.id, now + 1);
    expect(order).toMatchObject({
      state: "pending_payment",
      paymentState: "not_started",
      fulfillment: "none",
      quote: saved.quote,
    });
    expect((await balance(a.variantId))?.checkout_reserved).toBe(2);
    expect((await balance(b.variantId))?.checkout_reserved).toBe(1);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM commerce_order_lines WHERE order_id = ?",
        order.id,
      ),
    ).toBe(2);
    await db
      .prepare(
        "UPDATE commerce_variants SET price_cents = 9000, version = version + 1 WHERE id = ?",
      )
      .bind(a.variantId)
      .run();
    expect((await getTestOrder(db, owner, order.id))?.quote).toEqual(
      saved.quote,
    );
  });

  it("allows only one of two shoppers to reserve the last unit", async () => {
    const a = await quoted(1, 1);
    const b = await createTestQuote(
      db,
      otherOwner,
      [{ variantId: a.variantId, quantity: 1 }],
      "pickup",
      now,
    );
    const results = await Promise.allSettled([
      reserveTestOrder(db, owner, a.id, now + 1),
      reserveTestOrder(db, otherOwner, b.id, now + 1),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect((await balance(a.variantId))?.checkout_reserved).toBe(1);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM commerce_order_lines WHERE variant_id = ?",
        a.variantId,
      ),
    ).toBe(1);
  });

  it("replays concurrent or response-lost submissions as one order even after quote expiry", async () => {
    const saved = await quoted();
    const orders = await Promise.all([
      reserveTestOrder(db, owner, saved.id, now + 1),
      reserveTestOrder(db, owner, saved.id, now + 1),
    ]);
    expect(orders[0]).toEqual(orders[1]);
    const replay = await reserveTestOrder(
      db,
      owner,
      saved.id,
      saved.quote.expiresAt + 1,
    );
    expect(replay).toEqual(orders[0]);
    expect((await balance(saved.variantId))?.checkout_reserved).toBe(1);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM commerce_orders WHERE quote_id = ?",
        saved.id,
      ),
    ).toBe(1);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM commerce_stock_movements WHERE command_id = ?",
        `reserve-${saved.id}`,
      ),
    ).toBe(1);
  });

  it("does not disclose, reserve or cancel another shopper's order or quote", async () => {
    const saved = await quoted();
    await expect(
      reserveTestOrder(db, otherOwner, saved.id, now + 1),
    ).rejects.toMatchObject({ code: "not_found" });
    const order = await reserveTestOrder(db, owner, saved.id, now + 1);
    expect(await getTestOrder(db, otherOwner, order.id)).toBeNull();
    await expect(
      releaseTestOrder(db, otherOwner, order.id, "cancel", now + 2),
    ).rejects.toMatchObject({ code: "not_found" });
    expect((await balance(saved.variantId))?.checkout_reserved).toBe(1);
    expect((await getTestOrder(db, owner, order.id))?.state).toBe(
      "pending_payment",
    );
  });

  it("recovers only this browser owner's recent orders", async () => {
    const customer = "c".repeat(64);
    const saved = await quoted(1, 2, customer);
    const order = await reserveTestOrder(db, customer, saved.id, now + 1);
    expect(await listTestOrders(db, customer)).toEqual([order]);
    expect(await listTestOrders(db, "d".repeat(64))).toEqual([]);
  });

  it("rejects an unsubmitted quote at its expiry boundary", async () => {
    const saved = await quoted();
    await expect(
      reserveTestOrder(db, owner, saved.id, saved.quote.expiresAt),
    ).rejects.toMatchObject({ code: "quote_expired" });
    expect((await balance(saved.variantId))?.checkout_reserved).toBe(0);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM commerce_orders WHERE quote_id = ?",
        saved.id,
      ),
    ).toBe(0);
  });

  it.each(["price", "hidden", "inactive"] as const)(
    "rejects a %s change after quoting without leaving an order",
    async (change) => {
      const saved = await quoted();
      if (change === "hidden") {
        await db
          .prepare("UPDATE products SET status = 'hidden' WHERE id = ?")
          .bind(saved.productId)
          .run();
      } else {
        const sql =
          change === "price"
            ? "UPDATE commerce_variants SET price_cents = 2700, version = version + 1 WHERE id = ?"
            : "UPDATE commerce_variants SET active = 0, version = version + 1 WHERE id = ?";
        await db.prepare(sql).bind(saved.variantId).run();
      }
      await expect(
        reserveTestOrder(db, owner, saved.id, now + 1),
      ).rejects.toMatchObject({ code: "quote_changed" });
      expect((await balance(saved.variantId))?.checkout_reserved).toBe(0);
      expect(
        await count(
          "SELECT COUNT(*) AS n FROM commerce_orders WHERE quote_id = ?",
          saved.id,
        ),
      ).toBe(0);
      expect(
        await count(
          "SELECT COUNT(*) AS n FROM commerce_commands WHERE id = ?",
          `reserve-${saved.id}`,
        ),
      ).toBe(0);
    },
  );

  it("rolls back earlier lines, order, command and movements when a later line loses stock", async () => {
    const a = await variant(2);
    const b = await variant(1);
    const saved = await createTestQuote(
      db,
      owner,
      [
        { variantId: a.variantId, quantity: 1 },
        { variantId: b.variantId, quantity: 1 },
      ],
      "pickup",
      now,
    );
    await applyStockCommand(
      db,
      `fb-${b.variantId}`,
      [
        {
          variantId: b.variantId,
          kind: "fb_reserve",
          quantity: 1,
          reason: "Separate channel",
        },
      ],
      now,
    );
    await expect(
      reserveTestOrder(db, owner, saved.id, now + 1),
    ).rejects.toMatchObject({ code: "quote_changed" });
    expect((await balance(a.variantId))?.checkout_reserved).toBe(0);
    expect((await balance(b.variantId))?.facebook_reserved).toBe(1);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM commerce_orders WHERE quote_id = ?",
        saved.id,
      ),
    ).toBe(0);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM commerce_order_lines WHERE order_id = ?",
        `order-${saved.id}`,
      ),
    ).toBe(0);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM commerce_commands WHERE id = ?",
        `reserve-${saved.id}`,
      ),
    ).toBe(0);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM commerce_stock_movements WHERE command_id = ?",
        `reserve-${saved.id}`,
      ),
    ).toBe(0);
  });

  it("cancel and expiry races release only this order once, preserving another owner's reservation", async () => {
    const saved = await quoted(1, 3);
    const other = await createTestQuote(
      db,
      otherOwner,
      [{ variantId: saved.variantId, quantity: 1 }],
      "pickup",
      now,
    );
    const first = await reserveTestOrder(db, owner, saved.id, now + 1);
    const second = await reserveTestOrder(db, otherOwner, other.id, now + 1);
    const results = await Promise.all([
      releaseTestOrder(db, owner, first.id, "cancel", first.reserveUntil),
      releaseTestOrder(db, owner, first.id, "expire", first.reserveUntil),
    ]);
    expect(results.every((result) => result.state === "cancelled")).toBe(true);
    expect((await balance(saved.variantId))?.checkout_reserved).toBe(1);
    expect((await getTestOrder(db, otherOwner, second.id))?.state).toBe(
      "pending_payment",
    );
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM commerce_order_transitions WHERE order_id = ?",
        first.id,
      ),
    ).toBe(1);
    await releaseTestOrder(
      db,
      owner,
      first.id,
      "cancel",
      first.reserveUntil + 1,
    );
    expect((await balance(saved.variantId))?.checkout_reserved).toBe(1);
    const replay = await reserveTestOrder(
      db,
      owner,
      saved.id,
      first.reserveUntil + 2,
    );
    expect(replay.state).toBe("cancelled");
    expect((await balance(saved.variantId))?.checkout_reserved).toBe(1);
  });

  it("refuses early expiry and releases at the deadline without decrementing physical stock", async () => {
    const saved = await quoted();
    const order = await reserveTestOrder(db, owner, saved.id, now + 1);
    await expect(
      releaseTestOrder(db, owner, order.id, "expire", order.reserveUntil - 1),
    ).rejects.toMatchObject({ code: "order_conflict" });
    expect((await balance(saved.variantId))?.checkout_reserved).toBe(1);
    expect(
      (
        await releaseTestOrder(
          db,
          owner,
          order.id,
          "expire",
          order.reserveUntil,
        )
      ).state,
    ).toBe("cancelled");
    expect(await balance(saved.variantId)).toMatchObject({
      on_hand: 3,
      checkout_reserved: 0,
    });
  });

  it.each(["processing", "unknown"] as const)(
    "never blindly releases an order whose payment is %s",
    async (paymentState) => {
      const saved = await quoted();
      const order = await reserveTestOrder(db, owner, saved.id, now + 1);
      // Fixture only: there is no payment provider or public payment mutation here.
      await db
        .prepare(
          "UPDATE commerce_orders SET payment_state = ?, version = version + 1 WHERE id = ?",
        )
        .bind(paymentState, order.id)
        .run();
      for (const kind of ["cancel", "expire"] as const) {
        await expect(
          releaseTestOrder(db, owner, order.id, kind, order.reserveUntil),
        ).rejects.toMatchObject({ code: "order_conflict" });
      }
      expect((await balance(saved.variantId))?.checkout_reserved).toBe(1);
      expect(
        await count(
          "SELECT COUNT(*) AS n FROM commerce_order_transitions WHERE order_id = ?",
          order.id,
        ),
      ).toBe(0);
    },
  );

  it("quotes a requested in-stock variant beyond the first catalog page", async () => {
    const item = await variant(1);
    await db.batch(
      Array.from({ length: 200 }, (_, index) => {
        const id = `a-pagination-${index}`;
        return db
          .prepare(
            `INSERT INTO commerce_variants(id, product_id, sku, colour, size_description, price_cents, active)
             VALUES (?, ?, ?, ?, 'Fictional single size', 2500, 1)`,
          )
          .bind(id, item.productId, id, `Fictional colour ${index}`);
      }),
    );
    const saved = await createTestQuote(
      db,
      owner,
      [{ variantId: item.variantId, quantity: 1 }],
      "pickup",
      now,
    );
    expect(saved.quote.lines[0]?.variantId).toBe(item.variantId);
    expect((await balance(item.variantId))?.checkout_reserved).toBe(0);
  });
});
