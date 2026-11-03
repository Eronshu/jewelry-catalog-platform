import { isRouteErrorResponse, Link, useLoaderData } from "react-router";
import type { Route } from "./+types/admin-commerce-allocation-release";
import {
  loadOwnerAllocationReleasePage,
  type OwnerAllocationReleasePage,
} from "../lib/commerce/owner-allocation-release-http.server";
import { OwnerAllocationReleaseOperations } from "../components/admin/owner-allocation-release-operations";
import { AdminShell } from "../components/admin/admin-shell";
export const loader = ({ request, context, params }: Route.LoaderArgs) =>
  loadOwnerAllocationReleasePage(request, context, params.orderId);
export const action = loader;
export { headers, meta } from "./admin-commerce";
export default function AllocationReleasePage() {
  const data = useLoaderData<OwnerAllocationReleasePage>();
  return (
    <OwnerAllocationReleaseOperations
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
            : "Stock release page unavailable"}
        </h1>
        <p>
          Order, refund and stock history are preserved. Keep any pending
          request and ask the developer to check it before another stock action.
        </p>
        <Link to="/admin/commerce/orders">Back to orders</Link>
      </section>
    </AdminShell>
  );
}
