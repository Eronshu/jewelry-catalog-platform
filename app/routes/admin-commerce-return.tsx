import { isRouteErrorResponse, Link, useLoaderData } from "react-router";
import type { Route } from "./+types/admin-commerce-return";
import {
  loadOwnerReturnPage,
  type OwnerReturnPage,
} from "../lib/commerce/owner-return-http.server";
import { OwnerReturnOperations } from "../components/admin/owner-return-operations";
import { AdminShell } from "../components/admin/admin-shell";
export const loader = ({ request, context, params }: Route.LoaderArgs) =>
  loadOwnerReturnPage(request, context, params.orderId);
export const action = loader;
export { headers, meta } from "./admin-commerce";
export default function ReturnPage() {
  const data = useLoaderData<OwnerReturnPage>();
  return (
    <OwnerReturnOperations
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
            : "Test return page unavailable"}
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
