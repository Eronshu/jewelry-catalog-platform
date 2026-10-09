import type { ReactNode } from "react";
import { Link, useNavigation } from "react-router";

export function AdminShell({ children }: { children: ReactNode }) {
  const navigation = useNavigation();
  const openingWebsite =
    navigation.state !== "idle" && navigation.location?.pathname === "/";

  return (
    <div className="admin-shell">
      <header className="admin-header">
        <div className="admin-header-inner">
          <Link className="admin-label" to="/admin">
            Catalog admin
          </Link>
          <nav aria-label="Admin navigation" className="admin-nav">
            <Link to="/admin/products">Products</Link>
            <Link to="/admin/products/new">Add product</Link>
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

export function AdminWelcome() {
  return (
    <AdminShell>
      <section aria-labelledby="admin-title" className="admin-panel">
        <p className="admin-kicker">Administration</p>
        <h1 id="admin-title">Your catalog workspace</h1>
        <p>Manage your jewelry catalog in one place.</p>
        <p>
          <Link to="/admin/products">View products</Link>
        </p>
      </section>
    </AdminShell>
  );
}
