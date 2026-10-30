import { data, type RouterContextProvider } from "react-router";
import { cloudflareContext } from "../../cloudflare-context";
import { requireAdmin } from "../auth/admin-access.server";
import { checkoutConfig } from "./checkout-config.server";
import type {
  WorkspaceLine,
  WorkspaceOrder,
  WorkspaceOrderFilter,
  WorkspaceStock,
  WorkspaceStockFilter,
  WorkspaceSummary,
  WorkspaceView,
} from "./workspace";

export const workspaceHeaders = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
};
type Page = "overview" | "orders" | "order" | "inventory";
const orderPattern =
  /^order-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const maxDate = 8_640_000_000_000_000;
const pageSize = 25;
function reject(status: number, message: string): never {
  throw new Response(message, { status, headers: workspaceHeaders });
}
function invalid(): never {
  return reject(400, "Review the workspace filters and try again.");
}
function encode(value: object): string {
  return btoa(
    String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
function decode(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  if (value.length > 1200 || !/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  try {
    const result = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(
          atob(value.replaceAll("-", "+").replaceAll("_", "/")),
          (c) => c.charCodeAt(0),
        ),
      ),
    );
    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      encode(result) !== value
    )
      invalid();
    return result;
  } catch {
    return invalid();
  }
}
function exact(value: Record<string, unknown>, keys: string[]) {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    invalid();
}
const source = `FROM commerce_checkout_order_origins x JOIN commerce_orders o ON o.id=x.order_id
 WHERE x.mode=? AND x.instance_id=? AND o.owner_hash=x.owner_hash
 AND o.quote_id=x.promoted_quote_id AND o.reserve_command_id=x.command_id`;
const attempted = `EXISTS(SELECT 1 FROM commerce_payment_attempts a WHERE a.order_id=o.id)`;
const orderColumns = `o.id AS reference,o.created_at AS createdAt,o.reserve_until AS reserveUntil,
 o.state AS orderState,o.payment_state AS paymentState,o.fulfillment AS fulfillmentState,
 ${attempted} AS hasPaymentAttempt,
 (SELECT COALESCE(SUM(l.quantity),0) FROM commerce_order_lines l WHERE l.order_id=o.id) AS itemCount,
 json_extract(o.snapshot,'$.delivery') AS delivery,
 json_extract(o.snapshot,'$.subtotalCents') AS subtotalCents,
 json_extract(o.snapshot,'$.shippingCents') AS shippingCents,
 json_extract(o.snapshot,'$.taxCents') AS taxCents,
 json_extract(o.snapshot,'$.totalCents') AS totalCents`;
type OrderRow = Omit<WorkspaceOrder, "hasPaymentAttempt"> & {
  hasPaymentAttempt: number;
};
function order(row: OrderRow): WorkspaceOrder {
  return { ...row, hasPaymentAttempt: row.hasPaymentAttempt === 1 };
}
const freeUnits =
  "i.on_hand-i.facebook_reserved-i.checkout_reserved-i.allocated";
const websiteUnits = `CASE WHEN v.active=1 AND p.status='available' THEN ${freeUnits} ELSE 0 END`;
const stockSource =
  "FROM commerce_variants v JOIN products p ON p.id=v.product_id JOIN commerce_inventory i ON i.variant_id=v.id";
const stockSummary = `SELECT COUNT(*) AS variantCount,COALESCE(SUM(${websiteUnits}),0) AS availableUnits,
 COALESCE(SUM(i.facebook_reserved),0) AS facebookUnits,COALESCE(SUM(i.checkout_reserved),0) AS reservedUnits,
 COALESCE(SUM(i.allocated),0) AS allocatedUnits ${stockSource}`;
const conditions: Record<WorkspaceOrderFilter, string> = {
  all: "1=1",
  awaiting: `o.state='pending_payment' AND o.payment_state='not_started' AND NOT ${attempted}`,
  prepared: `o.state='pending_payment' AND o.payment_state='processing' AND ${attempted}`,
  cancelled: "o.state='cancelled'",
};

/** GET-only owner projection of this isolated checkout instance, not the legacy lab.
 * Auth and availability must precede every database access. No writes/providers. */
export async function loadCommerceWorkspace(
  request: Request,
  context: Readonly<RouterContextProvider>,
  page: Page,
  reference?: string,
) {
  requireAdmin(context);
  const env = context.get(cloudflareContext).env;
  const config = checkoutConfig(request, env);
  if (request.method !== "GET")
    throw new Response("Use GET to view this workspace.", {
      status: 405,
      headers: { ...workspaceHeaders, Allow: "GET" },
    });
  const params = new URL(request.url).searchParams;
  const allowed =
    page === "orders"
      ? ["status", "reference", "after"]
      : page === "inventory"
        ? ["status", "search", "after"]
        : [];
  if (
    [...params.keys()].some(
      (key) => !allowed.includes(key) || params.getAll(key).length !== 1,
    )
  )
    invalid();
  const scope = [config.mode, config.instanceId];
  const observedAt = Date.now();
  try {
    let view: WorkspaceView;
    if (page === "overview") {
      const [orders, stock, recent] = await env.DB.batch([
        env.DB.prepare(
          `SELECT COUNT(CASE WHEN ${conditions.awaiting} THEN 1 END) AS pendingCount,
          COUNT(CASE WHEN ${conditions.prepared} THEN 1 END) AS preparedCount,
          COUNT(CASE WHEN o.state='cancelled' THEN 1 END) AS cancelledCount ${source}`,
        ).bind(...scope),
        env.DB.prepare(stockSummary),
        env.DB.prepare(
          `SELECT ${orderColumns} ${source} ORDER BY o.created_at DESC,o.id DESC LIMIT 5`,
        ).bind(...scope),
      ]);
      view = {
        kind: "overview",
        observedAt,
        summary: {
          ...(orders.results[0] as Pick<
            WorkspaceSummary,
            "pendingCount" | "preparedCount" | "cancelledCount"
          >),
          ...(stock.results[0] as Omit<
            WorkspaceSummary,
            "pendingCount" | "preparedCount" | "cancelledCount"
          >),
        } as WorkspaceSummary,
        recentOrders: (recent.results as OrderRow[]).map(order),
      };
    } else if (page === "order") {
      if (!reference || !orderPattern.test(reference))
        reject(404, "Test order not found.");
      const [orders, lines] = await env.DB.batch([
        env.DB.prepare(`SELECT ${orderColumns} ${source} AND o.id=?`).bind(
          ...scope,
          reference,
        ),
        env.DB.prepare(
          `SELECT json_extract(j.value,'$.name') AS name,json_extract(j.value,'$.sku') AS sku,
          json_extract(j.value,'$.colour') AS colour,json_extract(j.value,'$.sizeDescription') AS sizeDescription,
          json_extract(j.value,'$.quantity') AS quantity,json_extract(j.value,'$.unitPriceCents') AS unitPriceCents,
          json_extract(j.value,'$.lineTotalCents') AS lineTotalCents
          FROM commerce_checkout_order_origins x JOIN commerce_orders o ON o.id=x.order_id
          JOIN json_each(o.snapshot,'$.lines') j
          WHERE x.mode=? AND x.instance_id=? AND x.owner_hash=o.owner_hash
          AND o.quote_id=x.promoted_quote_id AND o.reserve_command_id=x.command_id AND o.id=?
          ORDER BY CAST(j.key AS INTEGER) LIMIT 21`,
        ).bind(...scope, reference),
      ]);
      if (!orders.results[0]) reject(404, "Test order not found.");
      if (lines.results.length > 20) throw new Error("Invalid line count");
      view = {
        kind: "order",
        observedAt,
        order: order(orders.results[0] as OrderRow),
        lines: lines.results as WorkspaceLine[],
      };
    } else if (page === "orders") {
      const filter = params.get("status") ?? "all";
      if (!Object.hasOwn(conditions, filter)) invalid();
      const search = params.get("reference") ?? "";
      if (search && !orderPattern.test(search)) invalid();
      const cursor = decode(params.get("after"));
      if (cursor) {
        exact(cursor, ["createdAt", "reference", "status", "search"]);
        if (
          !Number.isSafeInteger(cursor.createdAt) ||
          (cursor.createdAt as number) < 0 ||
          (cursor.createdAt as number) > maxDate ||
          typeof cursor.reference !== "string" ||
          !orderPattern.test(cursor.reference) ||
          cursor.status !== filter ||
          cursor.search !== search
        )
          invalid();
      }
      const rows = (
        await env.DB.prepare(
          `SELECT ${orderColumns} ${source} AND ${conditions[filter as WorkspaceOrderFilter]}
        AND (?='' OR o.id=?) AND (o.created_at,o.id)<(?,?)
        ORDER BY o.created_at DESC,o.id DESC LIMIT 26`,
        )
          .bind(
            ...scope,
            search,
            search,
            cursor?.createdAt ?? maxDate,
            cursor?.reference ?? "\uffff",
          )
          .all<OrderRow>()
      ).results;
      const items = rows.slice(0, pageSize).map(order),
        last = items.at(-1);
      view = {
        kind: "orders",
        observedAt,
        items,
        filter: filter as WorkspaceOrderFilter,
        reference: search,
        nextCursor:
          rows.length > pageSize && last
            ? encode({
                createdAt: last.createdAt,
                reference: last.reference,
                status: filter,
                search,
              })
            : null,
      };
    } else {
      const filter = params.get("status") ?? "all";
      if (!["all", "available", "unavailable"].includes(filter)) invalid();
      const search = params.get("search") ?? "";
      if (search.length > 80 || /[\u0000-\u001f\u007f]/.test(search)) invalid();
      const cursor = decode(params.get("after"));
      if (cursor) {
        exact(cursor, ["variantId", "status", "search"]);
        if (
          typeof cursor.variantId !== "string" ||
          cursor.variantId.length > 100 ||
          !cursor.variantId ||
          cursor.status !== filter ||
          cursor.search !== search
        )
          invalid();
      }
      const pattern =
        "%" +
        search
          .replaceAll("!", "!!")
          .replaceAll("%", "!%")
          .replaceAll("_", "!_") +
        "%";
      type StockRow = Omit<WorkspaceStock, "active"> & { active: number };
      const rows = (
        await env.DB.prepare(
          `SELECT v.id AS variantId,v.product_id AS productId,p.name AS productName,
        v.sku,v.colour,v.size_description AS sizeDescription,v.price_cents AS priceCents,v.active,p.status AS productStatus,
        i.on_hand AS onHand,i.facebook_reserved AS facebookReserved,i.checkout_reserved AS checkoutReserved,
        i.allocated,${websiteUnits} AS websiteAvailable ${stockSource}
        WHERE v.id>? AND (p.name LIKE ? ESCAPE '!' OR v.sku LIKE ? ESCAPE '!' OR v.colour LIKE ? ESCAPE '!')
        AND (?='all' OR (?='available' AND ${websiteUnits}>0) OR (?='unavailable' AND ${websiteUnits}=0))
        ORDER BY v.id LIMIT 26`,
        )
          .bind(
            cursor?.variantId ?? "",
            pattern,
            pattern,
            pattern,
            filter,
            filter,
            filter,
          )
          .all<StockRow>()
      ).results;
      const items = rows
          .slice(0, pageSize)
          .map((row) => ({ ...row, active: row.active === 1 })),
        last = items.at(-1);
      view = {
        kind: "inventory",
        observedAt,
        items,
        filter: filter as WorkspaceStockFilter,
        search,
        nextCursor:
          rows.length > pageSize && last
            ? encode({ variantId: last.variantId, status: filter, search })
            : null,
      };
    }
    return data(view, { headers: workspaceHeaders });
  } catch (error) {
    if (error instanceof Response) throw error;
    return reject(
      503,
      "The commerce workspace is temporarily unavailable. Try again.",
    );
  }
}
