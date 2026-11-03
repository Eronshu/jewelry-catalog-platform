import { isRouteErrorResponse, Link, useLoaderData } from "react-router";
import type { Route } from "./+types/admin-commerce-notifications";
import {
  loadOwnerNotificationPage,
  notificationHeaders,
  type OwnerNotificationPage,
} from "../lib/commerce/order-notification-http.server";
import { OwnerNotifications } from "../components/admin/owner-notifications";
import { AdminShell } from "../components/admin/admin-shell";
export const loader = ({ request, context, params }: Route.LoaderArgs) =>
  loadOwnerNotificationPage(request, context, params.orderId);
export const action = loader;
export const headers = () => notificationHeaders;
export const meta = () => [
  { title: "Test order notifications | Admin" },
  { name: "robots", content: "noindex, nofollow" },
];
export default function NotificationPage() {
  const data = useLoaderData<OwnerNotificationPage>();
  return <OwnerNotifications {...data} />;
}
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const status = isRouteErrorResponse(error) ? error.status : 503;
  return (
    <AdminShell>
      <section className="admin-panel">
        <h1>
          {status === 401 || status === 403
            ? "Admin access required"
            : "Test notifications unavailable"}
        </h1>
        <p>Order history is preserved. Keep any original pending request.</p>
        <Link to="/admin/commerce/orders">Back to orders</Link>
      </section>
    </AdminShell>
  );
}
