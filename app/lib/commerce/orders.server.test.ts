import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { applyStockCommand } from "./inventory.server";
import {
  createTestQuote,
  getTestOrder,
  listTestOrders,
  releaseTestOrder,
  reserveTestOrder,
} from "./orders.server";
import { expireTestOrderBatch } from "./order-expiry.server";
import { handleWorkerRequest } from "../../../workers/app";
import { createLocalExpiryDriver } from "../../../scripts/commerce-expiry-driver.mjs";

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

describe("bounded internal expiry batches on real local D1", () => {
  beforeEach(async () => {
    // Retire earlier fictional fixtures with the established cancel command;
    // each batch test starts with no eligible orders, not a mocked database.
    const previous = await db
      .prepare(
        `SELECT id, owner_hash AS owner FROM commerce_orders
         WHERE state = 'pending_payment' AND payment_state = 'not_started'`,
      )
      .all<{ id: string; owner: string }>();
    for (const order of previous.results)
      await releaseTestOrder(
        db,
        order.owner,
        order.id,
        "cancel",
        now + 900_000,
      );
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db
      .prepare("DROP TRIGGER IF EXISTS expiry_test_release_failure")
      .run();
  });

  it("runs the authenticated driver through the Worker on local D1, stops at a page and restarts a fresh sweep", async () => {
    const items = [];
    for (let index = 0; index < 11; index++)
      items.push(await reserved(index % 2 ? owner : otherOwner));
    vi.spyOn(Date, "now").mockReturnValue(now + 900_002);
    const origin = "http://127.0.0.1:8792";
    const token = "c".repeat(64);
    const localEnv = {
      DB: db,
      COMMERCE_MODE: "local-test",
      COMMERCE_LOCAL_EXPIRY_TOKEN: token,
    } as unknown as Env;
    const fetcher: typeof fetch = async (url, init) =>
      handleWorkerRequest(
        new Request(String(url), init),
        localEnv,
        {} as ExecutionContext,
      );
    async function onePage() {
      const messages: string[] = [];
      await new Promise<void>((resolve, reject) => {
        const driver = createLocalExpiryDriver({
          origin,
          token,
          fetcher,
          report(message) {
            messages.push(message);
            if (message.startsWith("Local expiry observed:")) {
              driver.stop();
              resolve();
            } else if (message.includes("stopped:")) {
              driver.stop();
              reject(new Error("Local driver failed"));
            }
          },
        });
        driver.start();
      });
      return messages.join(" ");
    }
    expect(await onePage()).toContain("cancelled=10");
    expect(
      (
        await Promise.all(
          items.map((item) => getTestOrder(db, item.customer, item.order.id)),
        )
      ).filter((order) => order?.state === "cancelled"),
    ).toHaveLength(10);
    // New driver has no cursor; persisted state is authoritative, not its timer.
    expect(await onePage()).toContain("cancelled=1");
    expect(await onePage()).toContain("cancelled=0");
    for (const item of items) {
      expect(await balance(item.variantId)).toMatchObject({
        on_hand: 3,
        checkout_reserved: 0,
      });
      expect(await transitions(item.order.id)).toBe(1);
    }
  }, 15_000);

  async function reserved(customer = owner, offset = 1) {
    const saved = await quoted(1, 3, customer);
    const order = await reserveTestOrder(db, customer, saved.id, now + offset);
    return { ...saved, order, customer };
  }
  function interceptBatch(
    before?: () => Promise<unknown>,
    after?: () => void,
  ): D1Database {
    return new Proxy(db, {
      get(target, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            await before?.();
            const result = await target.batch(statements);
            after?.();
            return result;
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  async function transitions(orderId: string) {
    return count(
      "SELECT COUNT(*) AS n FROM commerce_order_transitions WHERE order_id = ?",
      orderId,
    );
  }

  it("expires at the boundary in bounded stable pages across owners, preserving physical stock and Facebook allocation", async () => {
    const saved = [
      await reserved(),
      await reserved(otherOwner),
      await reserved(),
    ];
    await applyStockCommand(
      db,
      `fb-${saved[0].variantId}`,
      [
        {
          variantId: saved[0].variantId,
          kind: "fb_reserve",
          quantity: 1,
          reason: "Fictional channel allocation",
        },
      ],
      now,
    );
    const deadline = saved[0].order.reserveUntil;
    expect(await expireTestOrderBatch(db, { now: deadline - 1 })).toEqual({
      outcomes: [],
      nextCursor: null,
      stopped: false,
    });
    const sorted = saved.map((s) => s.order.id).sort();
    const first = await expireTestOrderBatch(db, { now: deadline, limit: 2 });
    expect(first.outcomes).toEqual(
      sorted.slice(0, 2).map((orderId) => ({ orderId, outcome: "cancelled" })),
    );
    expect(first.nextCursor).toEqual({
      reserveUntil: deadline,
      orderId: sorted[1],
    });
    const second = await expireTestOrderBatch(db, {
      now: deadline,
      limit: 2,
      after: first.nextCursor!,
    });
    expect(second.outcomes).toEqual([
      { orderId: sorted[2], outcome: "cancelled" },
    ]);
    expect(second.nextCursor).toBeNull();
    expect(
      (await expireTestOrderBatch(db, { now: deadline })).outcomes,
    ).toEqual([]);
    for (const item of saved) {
      expect(await balance(item.variantId)).toMatchObject({
        on_hand: 3,
        checkout_reserved: 0,
        allocated: 0,
      });
      expect(await transitions(item.order.id)).toBe(1);
    }
    expect((await balance(saved[0].variantId))?.facebook_reserved).toBe(1);
  });

  it("excludes future, held, confirmed and all started/unknown/completed/failed payment states", async () => {
    const protectedOrders = [];
    for (const payment of ["processing", "unknown", "succeeded", "failed"]) {
      const item = await reserved();
      await db
        .prepare("UPDATE commerce_orders SET payment_state = ? WHERE id = ?")
        .bind(payment, item.order.id)
        .run();
      protectedOrders.push(item);
    }
    const held = await reserved();
    await db
      .prepare("UPDATE commerce_orders SET fulfillment = 'held' WHERE id = ?")
      .bind(held.order.id)
      .run();
    const confirmed = await reserved();
    await db
      .prepare("UPDATE commerce_orders SET state = 'confirmed' WHERE id = ?")
      .bind(confirmed.order.id)
      .run();
    protectedOrders.push(held, confirmed, await reserved(owner, 10));
    const eligible = await reserved();
    const result = await expireTestOrderBatch(db, {
      now: eligible.order.reserveUntil,
    });
    expect(result.outcomes).toEqual([
      { orderId: eligible.order.id, outcome: "cancelled" },
    ]);
    for (const item of protectedOrders) {
      expect((await balance(item.variantId))?.checkout_reserved).toBe(1);
      expect(await transitions(item.order.id)).toBe(0);
    }
    await expect(
      releaseTestOrder(
        db,
        owner,
        held.order.id,
        "expire",
        eligible.order.reserveUntil,
      ),
    ).rejects.toMatchObject({ code: "order_conflict" });
  });

  it.each(["processing", "unknown", "held"])(
    "database guard preserves the reservation if %s is set after the release read but before its transaction",
    async (change) => {
      const item = await reserved();
      const raced = interceptBatch(() =>
        db
          .prepare(
            change === "held"
              ? "UPDATE commerce_orders SET fulfillment = 'held' WHERE id = ?"
              : "UPDATE commerce_orders SET payment_state = ? WHERE id = ?",
          )
          .bind(
            ...(change === "held" ? [item.order.id] : [change, item.order.id]),
          )
          .run(),
      );
      const result = await expireTestOrderBatch(raced, {
        now: item.order.reserveUntil,
      });
      expect(result.outcomes).toEqual([
        { orderId: item.order.id, outcome: "skipped" },
      ]);
      expect((await balance(item.variantId))?.checkout_reserved).toBe(1);
      expect(await transitions(item.order.id)).toBe(0);
      expect(
        await count(
          "SELECT COUNT(*) AS n FROM commerce_commands WHERE id = ?",
          `expire-${item.order.id}`,
        ),
      ).toBe(0);
    },
  );

  it("overlapping batches and manual cancellation release only once and preserve a later shopper's reservation", async () => {
    const first = await reserved();
    const other = await createTestQuote(
      db,
      otherOwner,
      [{ variantId: first.variantId, quantity: 1 }],
      "pickup",
      now,
    );
    const later = await reserveTestOrder(db, otherOwner, other.id, now + 2);
    const results = await Promise.all([
      expireTestOrderBatch(db, { now: first.order.reserveUntil }),
      expireTestOrderBatch(db, { now: first.order.reserveUntil }),
      releaseTestOrder(
        db,
        owner,
        first.order.id,
        "cancel",
        first.order.reserveUntil,
      ),
    ]);
    for (const batch of results.slice(0, 2)) {
      if ("outcomes" in batch)
        expect(batch.outcomes.every((item) => item.outcome !== "failed")).toBe(
          true,
        );
    }
    expect(await transitions(first.order.id)).toBe(1);
    expect((await balance(first.variantId))?.checkout_reserved).toBe(1);
    expect((await getTestOrder(db, otherOwner, later.id))?.state).toBe(
      "pending_payment",
    );
  });

  it("rolls back all lines of a failed release, advances past it, then retries safely in a fresh sweep", async () => {
    const a = await variant(2),
      b = await variant(2);
    const quote = await createTestQuote(
      db,
      owner,
      [
        { variantId: a.variantId, quantity: 1 },
        { variantId: b.variantId, quantity: 1 },
      ],
      "pickup",
      now,
    );
    const blocked = await reserveTestOrder(db, owner, quote.id, now + 1);
    const later = await reserved(owner, 2);
    await db
      .prepare(
        `CREATE TRIGGER expiry_test_release_failure BEFORE INSERT ON commerce_stock_movements
      WHEN NEW.kind = 'release' AND NEW.variant_id = '${b.variantId}'
      BEGIN SELECT RAISE(ABORT, 'fictional injected failure'); END;`,
      )
      .run();
    const failed = await expireTestOrderBatch(db, {
      now: later.order.reserveUntil,
      limit: 1,
    });
    expect(failed.outcomes).toEqual([
      { orderId: blocked.id, outcome: "failed" },
    ]);
    expect(failed.nextCursor).not.toBeNull();
    for (const item of [a, b])
      expect((await balance(item.variantId))?.checkout_reserved).toBe(1);
    expect(await transitions(blocked.id)).toBe(0);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM commerce_commands WHERE id = ?",
        `expire-${blocked.id}`,
      ),
    ).toBe(0);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM commerce_stock_movements WHERE command_id = ?",
        `expire-${blocked.id}`,
      ),
    ).toBe(0);
    const tail = await expireTestOrderBatch(db, {
      now: later.order.reserveUntil,
      limit: 1,
      after: failed.nextCursor!,
    });
    expect(tail.outcomes).toEqual([
      { orderId: later.order.id, outcome: "cancelled" },
    ]);
    await db.prepare("DROP TRIGGER expiry_test_release_failure").run();
    const retry = await expireTestOrderBatch(db, {
      now: later.order.reserveUntil,
    });
    expect(retry.outcomes).toEqual([
      { orderId: blocked.id, outcome: "cancelled" },
    ]);
    expect(await transitions(blocked.id)).toBe(1);
    expect(await transitions(later.order.id)).toBe(1);
    for (const item of [a, b])
      expect((await balance(item.variantId))?.checkout_reserved).toBe(0);
  });

  it("recovers after stopping between commits and restarting the local D1 runtime without a cursor", async () => {
    const saved = [
      await reserved(owner, 1),
      await reserved(otherOwner, 2),
      await reserved(owner, 3),
    ];
    const controller = new AbortController();
    const interrupted = interceptBatch(undefined, () => controller.abort());
    const partial = await expireTestOrderBatch(interrupted, {
      now: saved[2].order.reserveUntil,
      signal: controller.signal,
    });
    expect(partial.stopped).toBe(true);
    expect(partial.outcomes).toEqual([
      { orderId: saved[0].order.id, outcome: "cancelled" },
    ]);
    await platform.dispose();
    platform = await getPlatformProxy<Env>({
      configPath: join(root, "wrangler.jsonc"),
      envFiles: [],
      persist: { path: join(localDir, "v3") },
      remoteBindings: false,
    });
    db = platform.env.DB;
    const resumed = await expireTestOrderBatch(db, {
      now: saved[2].order.reserveUntil,
    });
    expect(resumed.outcomes.map((item) => item.orderId)).toEqual(
      saved.slice(1).map((item) => item.order.id),
    );
    for (const item of saved) {
      expect((await balance(item.variantId))?.checkout_reserved).toBe(0);
      expect(await transitions(item.order.id)).toBe(1);
    }
  });

  it.each([
    { limit: 0 },
    { limit: 26 },
    { limit: 1.5 },
    { now: -1 },
    { now: NaN },
    { now: 8_640_000_000_000_000 },
    { after: { reserveUntil: -1, orderId: "order-" + "a".repeat(36) } },
    {
      now,
      after: { reserveUntil: now + 1, orderId: "order-" + "a".repeat(36) },
    },
    { after: { reserveUntil: 1, orderId: "invalid" } },
  ])(
    "rejects invalid bounds/cursors before database access: %j",
    async (options) => {
      const prepare = vi.fn();
      await expect(
        expireTestOrderBatch({ prepare } as unknown as D1Database, options),
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect(prepare).not.toHaveBeenCalled();
    },
  );

  it("does no database work for an already stopped run", async () => {
    const prepare = vi.fn();
    const controller = new AbortController();
    controller.abort();
    expect(
      await expireTestOrderBatch({ prepare } as unknown as D1Database, {
        signal: controller.signal,
      }),
    ).toEqual({ outcomes: [], nextCursor: null, stopped: true });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("reports a scan outage without leaking database exception details", async () => {
    const broken = {
      prepare: () => ({
        bind: () => ({
          all: () => Promise.reject(new Error("private database details")),
        }),
      }),
    } as unknown as D1Database;
    await expect(expireTestOrderBatch(broken, { now })).rejects.toThrow(
      "Local reservation expiry scan unavailable",
    );
  });
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
