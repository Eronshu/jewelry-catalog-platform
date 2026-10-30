import type { ReactNode } from "react";
import { Link, useNavigation } from "react-router";

export function AdminShell({
  children,
  localReservations = false,
}: {
  children: ReactNode;
  localReservations?: boolean;
}) {
  const navigation = useNavigation();
  const openingWebsite =
    navigation.state !== "idle" && navigation.location?.pathname === "/";

  return (
    <div className="admin-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="admin-header">
        <div className="admin-header-inner">
          <Link className="admin-label" to="/admin">
            Catalog admin
          </Link>
          <nav
            aria-label="Admin navigation"
            className={
              localReservations
                ? "admin-nav admin-commerce-navigation"
                : "admin-nav"
            }
          >
            <Link to="/admin/products">Products</Link>
            <Link to="/admin/products/new">Add product</Link>
            {localReservations && (
              <>
                <Link to="/admin/commerce">Commerce</Link>
                <Link to="/admin/commerce/orders">Orders</Link>
                <Link to="/admin/commerce/inventory">Inventory</Link>
                <Link to="/admin/commerce/reservations">Test reservations</Link>
              </>
            )}
          </nav>
          <Link className="admin-back-link" to="/">
            <span aria-live="polite">
              {openingWebsite ? "Opening website…" : "View website"}
            </span>{" "}
            <span aria-hidden="true">↗</span>
          </Link>
        </div>
      </header>
      <main className="admin-main" id="main">
        {children}
      </main>
    </div>
  );
}

export function AdminWelcome({
  localReservations = false,
}: {
  localReservations?: boolean;
}) {
  return (
    <AdminShell localReservations={localReservations}>
      <section aria-labelledby="admin-title" className="admin-panel">
        <p className="admin-kicker">Administration</p>
        <h1 id="admin-title">Your catalog workspace</h1>
        <p>Manage your jewelry catalog in one place.</p>
        <p>
          <Link to="/admin/products">View products</Link>
        </p>
        {localReservations && (
          <div>
            <p>
              <Link to="/admin/commerce">Open commerce workspace</Link> · Local
              test only
            </p>
            <p>
              <Link to="/admin/commerce/reservations">
                Review test reservations
              </Link>{" "}
              · Local test only
            </p>
          </div>
        )}
      </section>
    </AdminShell>
  );
}
