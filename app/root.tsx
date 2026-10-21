import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLocation,
} from "react-router";

import type { Route } from "./+types/root";
import { AdminShell } from "./components/admin/admin-shell";
import { SiteShell } from "./components/storefront/site-shell";
import { isAdminPath } from "./lib/admin-path";
import "./app.css";
import { cloudflareContext } from "./cloudflare-context";
import { isLocalCommerceEnabled } from "./lib/commerce/environment.server";
import {
  ShoppingCartProvider,
  ShoppingNavigation,
} from "./components/storefront/shopping-cart-context";

export function loader({ request, context }: Route.LoaderArgs) {
  return {
    localShopping: isLocalCommerceEnabled(
      request,
      context.get(cloudflareContext).env,
    ),
  };
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App({ loaderData }: Route.ComponentProps) {
  const isAdmin = isAdminPath(useLocation().pathname);
  if (isAdmin) return <Outlet />;
  if (loaderData?.localShopping === true)
    return (
      <ShoppingCartProvider>
        <SiteShell>
          <ShoppingNavigation />
          <Outlet />
        </SiteShell>
      </ShoppingCartProvider>
    );
  return (
    <SiteShell>
      <Outlet />
    </SiteShell>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const isAdmin = isAdminPath(useLocation().pathname);
  const isRouteError = isRouteErrorResponse(error);
  const title =
    isRouteError && error.status === 404
      ? "Page not found"
      : "Something went wrong";
  const message =
    isRouteError && error.status === 404
      ? "The page you requested could not be found."
      : "Please try again later.";

  const content = (
    <div className="container error-content">
      {!isAdmin && <p className="eyebrow">Storefront</p>}
      <h1 className="page-title">{title}</h1>
      <p className="lead">{message}</p>
    </div>
  );
  if (isAdmin) return <AdminShell>{content}</AdminShell>;

  return <SiteShell>{content}</SiteShell>;
}
