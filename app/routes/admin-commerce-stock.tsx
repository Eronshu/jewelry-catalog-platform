import { isRouteErrorResponse, Link, useLoaderData } from "react-router";
import type { Route } from "./+types/admin-commerce-stock";
import {
  loadOwnerStockPage,
  type OwnerStockPage,
} from "../lib/commerce/owner-stock-http.server";
import { OwnerStockOperations } from "../components/admin/owner-stock-operations";
import { AdminShell } from "../components/admin/admin-shell";
export const loader = ({ request, context, params }: Route.LoaderArgs) =>
  loadOwnerStockPage(request, context, params.variantId);
export const action = loader;
export { headers, meta } from "./admin-commerce";
export default function StockPage() {
  const data = useLoaderData<OwnerStockPage>();
  return (
    <OwnerStockOperations
      key={`${data.instanceId}:${data.detail.item.variantId}`}
      {...data}
    />
  );
}
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const status = isRouteErrorResponse(error) ? error.status : 503;
  return (
    <AdminShell>
      <section className="admin-panel">
        <h1>
          {status === 401 || status === 403
            ? "Admin access required"
            : "Test stock page unavailable"}
        </h1>
        <p>
          Existing stock history is preserved. If a request was in progress,
          return to the same item and check that request before retrying.
        </p>
        <Link to="/admin/commerce/inventory">Back to inventory</Link>
      </section>
    </AdminShell>
  );
}
