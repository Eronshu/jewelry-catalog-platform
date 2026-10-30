import { isRouteErrorResponse, Link, useLoaderData } from "react-router";
import type { Route } from "./+types/admin-commerce";
import { CommerceWorkspace } from "../components/admin/commerce-workspace";
import {
  loadCommerceWorkspace,
  workspaceHeaders,
} from "../lib/commerce/workspace.server";
import type { WorkspaceView } from "../lib/commerce/workspace";
import { AdminShell } from "../components/admin/admin-shell";

export const loader = ({ request, context }: Route.LoaderArgs) =>
  loadCommerceWorkspace(request, context, "overview");
export const action = loader;
export function headers({
  loaderHeaders,
  actionHeaders,
  errorHeaders,
}: Route.HeadersArgs) {
  const allow =
    errorHeaders?.get("Allow") ??
    actionHeaders.get("Allow") ??
    loaderHeaders.get("Allow");
  return { ...workspaceHeaders, ...(allow ? { Allow: allow } : {}) };
}
export function meta() {
  return [
    { title: "Commerce workspace | Catalog admin" },
    { name: "robots", content: "noindex, nofollow" },
  ];
}
export default function Commerce() {
  return <CommerceWorkspace view={useLoaderData<WorkspaceView>()} />;
}
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const status = isRouteErrorResponse(error) ? error.status : 503;
  const title =
    status === 404
      ? "Test order or workspace not found"
      : status === 400
        ? "Review your workspace filters"
        : status === 405
          ? "This workspace is read only"
          : status === 401 || status === 403
            ? "Admin access is required"
            : "Commerce workspace is temporarily unavailable";
  return (
    <AdminShell>
      <section className="admin-panel" aria-labelledby="workspace-error-title">
        <h1 id="workspace-error-title">{title}</h1>
        <p>
          {status === 401 || status === 403
            ? "Use an approved account to open the admin area."
            : "No order or stock change was requested. Open the workspace or try again later."}
        </p>
        <p>
          <Link to="/admin/commerce">Open commerce workspace</Link>
        </p>
        <p>
          <Link to="/admin">Back to admin</Link>
        </p>
      </section>
    </AdminShell>
  );
}
