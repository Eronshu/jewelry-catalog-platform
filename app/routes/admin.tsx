import { isRouteErrorResponse } from "react-router";

import type { Route } from "./+types/admin";
import { AdminShell, AdminWelcome } from "../components/admin/admin-shell";
import { requireAdmin } from "../lib/auth/admin-access.server";

export function loader({ context }: Route.LoaderArgs) {
  requireAdmin(context);
  return null;
}

export function meta() {
  return [{ title: "Catalog admin" }, { name: "robots", content: "noindex" }];
}

export default function Admin() {
  return <AdminWelcome />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const title =
    status === 401
      ? "Admin access is required"
      : status === 403
        ? "You do not have access to this area"
        : "Admin is temporarily unavailable";
  return (
    <AdminShell>
      <section aria-labelledby="admin-error-title" className="admin-panel">
        <h1 id="admin-error-title">{title}</h1>
        <p>
          {status === 401 || status === 403
            ? "Please use an approved account to open the admin area."
            : "Please try again later."}
        </p>
      </section>
    </AdminShell>
  );
}
