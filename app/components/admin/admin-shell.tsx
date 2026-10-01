import type { ReactNode } from "react";

export function AdminShell({ children }: { children: ReactNode }) {
  return (
    <div className="admin-shell">
      <header className="admin-header">
        <div className="admin-header-inner">
          <span className="admin-label">Catalog admin</span>
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
        <p>
          Product management is coming soon. This area is ready for the tools
          you’ll use to manage your jewelry catalog.
        </p>
      </section>
    </AdminShell>
  );
}
