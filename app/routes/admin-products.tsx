import { data, Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/admin-products";
import { AdminShell } from "../components/admin/admin-shell";
import { cloudflareContext } from "../cloudflare-context";
import { requireAdmin } from "../lib/auth/admin-access.server";
import { readAdminForm } from "../lib/auth/admin-mutation.server";
import {
  AdminProductError,
  changeProduct,
  duplicateDraft,
  listAdminProducts,
  normalizeAdminListFilters,
  parseProductId,
  parseVersion,
  type ProductIntent,
} from "../lib/db/admin-products.server";
import { productImageUrl } from "../lib/images/image-urls";
import { formatAdminDate } from "../lib/format-admin-date";

export async function loader({ request, context }: Route.LoaderArgs) {
  requireAdmin(context);
  const url = new URL(request.url);
  const { env } = context.get(cloudflareContext);
  const list = await listAdminProducts(env.DB, {
    q: url.searchParams.get("q") ?? "",
    status: url.searchParams.get("status") ?? "all",
    cursor: url.searchParams.get("cursor") ?? "",
  });
  return {
    ...list,
    success: url.searchParams.get("message") === "updated",
    items: list.items.map((item) => ({
      ...item,
      requestKey: crypto.randomUUID(),
    })),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  requireAdmin(context);
  try {
    const form = await readAdminForm(request);
    const id = parseProductId(String(form.get("productId") ?? ""));
    const version = parseVersion(String(form.get("version") ?? ""));
    const intent = String(form.get("intent") ?? "");
    const { env } = context.get(cloudflareContext);
    if (intent === "duplicate") {
      const newId = await duplicateDraft(
        env.DB,
        id,
        version,
        String(form.get("requestKey") ?? ""),
      );
      return redirect(`/admin/products/${newId}/edit`);
    }
    if (
      ![
        "publish",
        "mark-sold",
        "mark-available",
        "hide",
        "draft",
        "archive",
        "restore",
      ].includes(intent)
    )
      throw new AdminProductError("This action is unavailable.", 400);
    await changeProduct(env, id, version, intent as ProductIntent);
    const url = new URL(request.url);
    const filters = normalizeAdminListFilters(
      url.searchParams.get("q") ?? "",
      url.searchParams.get("status") ?? "all",
    );
    const params = new URLSearchParams({ message: "updated" });
    if (filters.q) params.set("q", filters.q);
    if (filters.status !== "all") params.set("status", filters.status);
    return redirect(`/admin/products?${params}`);
  } catch (error) {
    if (error instanceof AdminProductError)
      return data({ error: error.message }, { status: error.status });
    throw error;
  }
}

export function meta() {
  return [
    { title: "Products | Catalog admin" },
    { name: "robots", content: "noindex" },
  ];
}

function Thumbnail({
  id,
  coverId,
  status,
  name,
}: {
  id: number;
  coverId: number | null;
  status: string;
  name: string;
}) {
  const publicImage = coverId && (status === "available" || status === "sold");
  return (
    <div className="admin-thumb">
      {publicImage ? (
        <img
          src={productImageUrl(id, coverId, "thumb")}
          alt={name}
          onError={(event) => {
            event.currentTarget.hidden = true;
          }}
        />
      ) : null}
      <span aria-hidden="true">No photo</span>
    </div>
  );
}

export default function AdminProducts({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const params = new URLSearchParams();
  if (loaderData.q) params.set("q", loaderData.q);
  if (loaderData.status !== "all") params.set("status", loaderData.status);
  const next = new URLSearchParams(params);
  if (loaderData.nextCursor) next.set("cursor", loaderData.nextCursor);
  const listAction = `/admin/products${params.size ? `?${params}` : ""}`;
  return (
    <AdminShell>
      <div className="admin-page-heading">
        <div>
          <h1>Products</h1>
          <p>Find and manage your catalog.</p>
        </div>
        <Link className="admin-primary-link" to="/admin/products/new">
          Add product
        </Link>
      </div>
      {actionData?.error && (
        <div className="admin-alert" role="alert">
          {actionData.error}
        </div>
      )}
      {loaderData.success && (
        <p className="admin-success" role="status">
          Product updated.
        </p>
      )}
      {busy && (
        <p className="admin-note" role="status">
          Updating product…
        </p>
      )}
      <Form
        key={JSON.stringify([loaderData.q, loaderData.status])}
        method="get"
        className="admin-filters"
      >
        <label>
          Search{" "}
          <input
            name="q"
            type="search"
            defaultValue={loaderData.q}
            maxLength={100}
            placeholder="Name, SKU, category, material"
          />
        </label>
        <label>
          Status{" "}
          <select name="status" defaultValue={loaderData.status}>
            {["all", "available", "sold", "draft", "hidden", "archived"].map(
              (status) => (
                <option key={status} value={status}>
                  {status === "all"
                    ? "All"
                    : status[0].toUpperCase() + status.slice(1)}
                </option>
              ),
            )}
          </select>
        </label>
        <button type="submit">Search</button>
        <Link to="/admin/products">Clear</Link>
      </Form>
      {loaderData.items.length === 0 ? (
        <section className="admin-empty">
          <h2>No products found</h2>
          <p>Try another search or status.</p>
        </section>
      ) : (
        <div className="admin-product-list">
          {loaderData.items.map((item) => (
            <article key={item.id} className="admin-product-row">
              <Thumbnail
                id={item.id}
                coverId={item.coverId}
                status={item.status}
                name={item.name}
              />
              <div className="admin-product-summary">
                <Link to={`/admin/products/${item.id}/edit`}>{item.name}</Link>
                <span>
                  {item.categoryName} · ${Math.floor(item.priceCents / 100)}.
                  {String(item.priceCents % 100).padStart(2, "0")} CAD
                </span>
                <span>
                  {item.sku || "No SKU"} · Updated{" "}
                  {formatAdminDate(item.updatedAt)}
                </span>
              </div>
              <strong className="admin-status">{item.status}</strong>
              <div className="admin-row-actions">
                <Link to={`/admin/products/${item.id}/edit`}>Edit</Link>
                <Form
                  method="post"
                  action={listAction}
                  onSubmit={(event) => {
                    const submitter = (event.nativeEvent as SubmitEvent)
                      .submitter as HTMLButtonElement | null;
                    if (
                      submitter?.value === "archive" &&
                      !window.confirm(`Archive ${item.name}?`)
                    )
                      event.preventDefault();
                  }}
                >
                  <input type="hidden" name="productId" value={item.id} />
                  <input type="hidden" name="version" value={item.updatedAt} />
                  <input
                    type="hidden"
                    name="requestKey"
                    value={item.requestKey}
                  />
                  {item.status === "archived" ? (
                    <button name="intent" value="restore" disabled={busy}>
                      Restore
                    </button>
                  ) : (
                    <>
                      {item.status === "available" && (
                        <button name="intent" value="mark-sold" disabled={busy}>
                          Mark Sold
                        </button>
                      )}
                      {item.status === "sold" && (
                        <button
                          name="intent"
                          value="mark-available"
                          disabled={busy}
                        >
                          Mark Available
                        </button>
                      )}
                      {item.status === "hidden" && (
                        <>
                          <button
                            name="intent"
                            value="publish"
                            disabled={busy || item.coverId === null}
                          >
                            Show Available
                          </button>
                          <button
                            name="intent"
                            value="mark-sold"
                            disabled={busy || item.coverId === null}
                          >
                            Show Sold
                          </button>
                          {item.coverId === null && (
                            <span className="admin-action-note">
                              Add a photo before showing this product. Photo
                              management is coming later.
                            </span>
                          )}
                        </>
                      )}
                      {(item.status === "available" ||
                        item.status === "sold") && (
                        <button name="intent" value="hide" disabled={busy}>
                          Hide
                        </button>
                      )}
                      <button name="intent" value="duplicate" disabled={busy}>
                        Duplicate
                      </button>
                      <button name="intent" value="archive" disabled={busy}>
                        Archive
                      </button>
                    </>
                  )}
                </Form>
              </div>
            </article>
          ))}
        </div>
      )}
      {loaderData.nextCursor && (
        <Link className="admin-more" to={`/admin/products?${next}`}>
          More products
        </Link>
      )}
    </AdminShell>
  );
}

export function ErrorBoundary() {
  return (
    <AdminShell>
      <div className="admin-alert" role="alert">
        <h1>Products are unavailable</h1>
        <p>Please try again later.</p>
        <Link to="/admin/products">Retry</Link>
      </div>
    </AdminShell>
  );
}
