import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyStockCommand } from "./inventory.server";
import {
  createTestQuote,
  releaseTestOrder,
  reserveTestOrder,
  type TestOrder,
} from "./orders.server";
import {
  inspectReservation,
  listReservationReview,
} from "./reservation-review.server";

const now = 1_800_000_000_000;
const root = resolve(process.cwd());
let directory: string;
let platform: PlatformProxy<Env>;
let db: D1Database;
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "jewelry-reservation-review-"));
  execFileSync(
    join(root, "node_modules/.bin/wrangler"),
    ["d1", "migrations", "apply", "DB", "--local", "--persist-to", directory],
    {
      env: {
        ...process.env,
        CI: "1",
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_LOG_PATH: join(directory, "wrangler.log"),
      },
      stdio: "pipe",
    },
  );
  platform = await getPlatformProxy<Env>({
    configPath: join(root, "wrangler.jsonc"),
    envFiles: [],
    persist: { path: join(directory, "v3") },
    remoteBindings: false,
  });
  db = platform.env.DB;
  await db.exec(`INSERT INTO products(id,name,slug,price_cents,quantity,category_id,status,created_at,updated_at) VALUES(1,'Fictional review','fictional-review',2500,0,1,'draft',1,1);
    INSERT INTO product_images(product_id,r2_key,sort_order,created_at) VALUES(1,'fictional/review.jpg',0,1);
    UPDATE products SET status='available' WHERE id=1;
    INSERT INTO commerce_variants(id,product_id,sku,colour,size_description,price_cents,active) VALUES('review-variant',1,'review-sku','Gold-tone','Fictional size',2500,1);`);
  await applyStockCommand(
    db,
    "review-receive",
    [
      {
        variantId: "review-variant",
        kind: "receive",
        quantity: 100,
        reason: "Fictional receipt",
      },
    ],
    now,
  );
}, 30_000);
afterAll(async () => {
  await platform?.dispose();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("reservation review minimal projections on real local D1", () => {
  it("pages across owners, inspects without session, preserves stock and redacts sensitive snapshots", async () => {
    const orders: Array<{ order: TestOrder; owner: string }> = [];
    for (let index = 0; index < 30; index++) {
      const owner = (index % 2 ? "a" : "b").repeat(64);
      const time = now + (index < 26 ? 1 : 2_000_000);
      const quote = await createTestQuote(
        db,
        owner,
        [{ variantId: "review-variant", quantity: 1 }],
        "pickup",
        time,
      );
      const order = await reserveTestOrder(db, owner, quote.id, time + 1);
      orders.push({ order, owner });
    }
    await db.batch([
      db
        .prepare(
          "UPDATE commerce_orders SET payment_state='unknown' WHERE id=?",
        )
        .bind(orders[26].order.id),
      db
        .prepare("UPDATE commerce_orders SET fulfillment='held' WHERE id=?")
        .bind(orders[27].order.id),
      db
        .prepare(
          "UPDATE commerce_orders SET snapshot=json_set(snapshot,'$.contact.email','sensitive-fictional@example.invalid','$.deliveryAddress','PRIVATE_FICTIONAL_ADDRESS') WHERE id=?",
        )
        .bind(orders[0].order.id),
    ]);
    const before = await db.prepare("SELECT * FROM commerce_inventory").all();
    const first = await listReservationReview(db, { now: now + 1_000_000 });
    expect(first.items).toHaveLength(25);
    expect(first.nextCursor).not.toBeNull();
    const second = await listReservationReview(db, {
      now: now + 1_000_000,
      after: first.nextCursor!,
    });
    expect(second.items).toHaveLength(3);
    expect(second.nextCursor).toBeNull();
    const items = [...first.items, ...second.items];
    expect(new Set(items.map((item) => item.id)).size).toBe(28);
    expect(
      items.filter((item) => item.reasons.includes("overdue_unpaid")),
    ).toHaveLength(26);
    expect(
      items.find((item) => item.id === orders[26].order.id)?.reasons,
    ).toEqual(["payment_review"]);
    expect(
      items.find((item) => item.id === orders[27].order.id)?.reasons,
    ).toEqual(["fulfillment_held"]);
    expect(items.slice(0, 26).map((item) => item.id)).toEqual(
      orders
        .slice(0, 26)
        .map((item) => item.order.id)
        .sort(),
    );
    const inspected = await inspectReservation(
      db,
      orders[0].order.id,
      now + 1_000_000,
    );
    expect(inspected?.lines).toEqual([
      { position: 0, variantId: "review-variant", quantity: 1 },
    ]);
    expect(inspected?.order.id).toBe(orders[0].order.id);
    expect(inspected?.history).toEqual([]);
    const json = JSON.stringify({ first, second, inspected });
    for (const forbidden of [
      "owner_hash",
      "ownerHash",
      "snapshot",
      "sensitive-fictional",
      "PRIVATE_FICTIONAL_ADDRESS",
      "a".repeat(64),
      "b".repeat(64),
    ])
      expect(json).not.toContain(forbidden);
    expect(
      (await db.prepare("SELECT * FROM commerce_inventory").all()).results,
    ).toEqual(before.results);
    // A state change between reads is observed, never cached as a release fact.
    await releaseTestOrder(
      db,
      orders[0].owner,
      orders[0].order.id,
      "cancel",
      now + 1_000_000,
    );
    const cancelled = await inspectReservation(
      db,
      orders[0].order.id,
      now + 1_000_001,
    );
    expect(cancelled?.order.state).toBe("cancelled");
    expect(cancelled?.order.reasons).toEqual([]);
    expect(cancelled?.history).toEqual([
      { kind: "cancel", occurredAt: now + 1_000_000, expectedVersion: 1 },
    ]);
    expect(
      (await listReservationReview(db, { now: now + 1_000_001 })).items.map(
        (item) => item.id,
      ),
    ).not.toContain(orders[0].order.id);
    expect(
      await inspectReservation(db, `order-${"0".repeat(36)}`, now),
    ).toBeNull();
  });
  it("validates references/cursors/clocks before DB access and hides failures", async () => {
    const absent = {} as D1Database;
    await expect(
      inspectReservation(absent, "invalid", now),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      listReservationReview(absent, { now: -1 }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    for (const after of [
      null,
      {},
      { reserveUntil: -1, orderId: "bad" },
      { reserveUntil: 0, orderId: `order-${"0".repeat(36)}`, extra: "ignored" },
    ])
      await expect(
        listReservationReview(absent, { now, after: after as never }),
      ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(listReservationReview(absent, { now })).rejects.toMatchObject({
      code: "unavailable",
      message: "Local reservation review unavailable",
    });
    await expect(
      inspectReservation(absent, `order-${"0".repeat(36)}`, now),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
});
