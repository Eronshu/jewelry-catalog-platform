import { isRouteErrorResponse, Link, useLoaderData } from "react-router";
import type { Route } from "./+types/admin-commerce-attention";
import {
  loadOwnerAttentionPage,
  attentionHeaders,
  type AttentionPage,
} from "../lib/commerce/owner-attention-http.server";
import { OwnerAttention } from "../components/admin/owner-attention";
import { AdminShell } from "../components/admin/admin-shell";
export const loader = ({ request, context }: Route.LoaderArgs) =>
  loadOwnerAttentionPage(request, context);
export const action = loader;
export const headers = ({ errorHeaders }: Route.HeadersArgs) => ({
  ...attentionHeaders,
  ...(errorHeaders?.get("Allow") ? { Allow: errorHeaders.get("Allow")! } : {}),
});
export const meta = () => [
  { title: "Orders needing attention | Admin" },
  { name: "robots", content: "noindex, nofollow" },
];
export default function Attention() {
  return <OwnerAttention {...useLoaderData<AttentionPage>()} />;
}
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const status = isRouteErrorResponse(error) ? error.status : 503;
  return (
    <AdminShell>
      <section className="admin-panel">
        <h1>
          {status === 401 || status === 403
            ? "Admin access required"
            : status === 400
              ? "Review attention filters"
              : status === 405
                ? "This attention view is read only"
                : "Attention view unavailable"}
        </h1>
        <p>
          No payment, refund, stock or notification action was requested. Keep
          any original pending request.
        </p>
        <Link to="/admin/commerce">Back to commerce workspace</Link>
      </section>
    </AdminShell>
  );
}
