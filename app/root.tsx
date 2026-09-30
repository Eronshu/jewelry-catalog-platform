import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import type { Route } from "./+types/root";
import { SiteShell } from "./components/storefront/site-shell";
import "./app.css";

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

export default function App() {
  return (
    <SiteShell>
      <Outlet />
    </SiteShell>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const isRouteError = isRouteErrorResponse(error);
  const title =
    isRouteError && error.status === 404
      ? "Page not found"
      : "Something went wrong";
  const message =
    isRouteError && error.status === 404
      ? "The page you requested could not be found."
      : "Please try again later.";

  return (
    <SiteShell>
      <div className="container error-content">
        <p className="eyebrow">Storefront</p>
        <h1 className="page-title">{title}</h1>
        <p className="lead">{message}</p>
      </div>
    </SiteShell>
  );
}
