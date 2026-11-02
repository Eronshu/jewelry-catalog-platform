import { isRouteErrorResponse, Link, useLoaderData } from "react-router";
import type { Route } from "./+types/admin-commerce-refund";
import {
  loadOwnerRefundPage,
  type OwnerRefundPage,
} from "../lib/commerce/owner-refund-http.server";
import { OwnerRefundOperations } from "../components/admin/owner-refund-operations";
import { AdminShell } from "../components/admin/admin-shell";
export const loader = ({ request, context, params }: Route.LoaderArgs) =>
  loadOwnerRefundPage(request, context, params.orderId);
export const action = loader;
export { headers, meta } from "./admin-commerce";
export default function RefundPage() {
  const data = useLoaderData<OwnerRefundPage>();
  return (
    <OwnerRefundOperations
      key={`${data.instanceId}:${data.detail.orderId}`}
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
            : "Test refund page unavailable"}
        </h1>
        <p>
          Order and stock history are preserved. Keep any pending request and
          ask the developer to check it before submitting another refund.
        </p>
        <Link to="/admin/commerce/orders">Back to orders</Link>
      </section>
    </AdminShell>
  );
}
