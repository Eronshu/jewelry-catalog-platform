import type { ReactNode } from "react";
import { Link } from "react-router";

export function AdminShell({ children }: { children: ReactNode }) {
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
          <a className="admin-back-link" href="/">
            View website <span aria-hidden="true">↗</span>
          </a>
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
