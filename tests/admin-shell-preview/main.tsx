import { createRoot } from "react-dom/client";
import { createBrowserRouter, Link, RouterProvider } from "react-router";

import "../../app/app.css";
import {
  AdminShell,
  AdminWelcome,
} from "../../app/components/admin/admin-shell";
import { PreviewForm, PreviewLinks, previewFormRoute } from "./preview-form";

// Presentation-only fixture: no route module, Worker, Access token or database.
function PreviewList() {
  return (
    <AdminShell>
      <PreviewLinks />
      <div className="admin-page-heading">
        <div>
          <h1>Products</h1>
          <p>Find and manage your catalog.</p>
        </div>
        <Link className="admin-primary-link" to="/form">
          Add product
        </Link>
      </div>
      <div className="admin-filters">
        <label>
          Search
          <input type="search" placeholder="Name, SKU, category, material" />
        </label>
        <label>
          Status
          <select defaultValue="all">
            <option value="all">All</option>
            <option>Available</option>
            <option>Draft</option>
          </select>
        </label>
        <button>Search</button>
      </div>
      <div className="admin-product-list">
        {[
          {
            name: "Fictional Orbit Hoops",
            category: "Earrings",
            price: "$28.00 CAD",
            status: "available",
          },
          {
            name: "Fictional New Ring",
            category: "Rings",
            price: "$29.95 CAD",
            status: "draft",
          },
        ].map((item) => (
          <article className="admin-product-row" key={item.name}>
            <div className="admin-thumb">
              <span>No photo</span>
            </div>
            <div className="admin-product-summary">
              <Link to="/form">{item.name}</Link>
              <span>
                {item.category} · {item.price}
              </span>
              <span>Updated today</span>
            </div>
            <strong className="admin-status">{item.status}</strong>
            <div className="admin-row-actions">
              <Link to="/form">Edit</Link>
              <button>Duplicate</button>
              <button>Archive</button>
            </div>
          </article>
        ))}
      </div>
    </AdminShell>
  );
}

const router = createBrowserRouter([
  {
    path: "/",
    element: (
      <>
        <AdminWelcome />
        <PreviewLinks />
      </>
    ),
  },
  { path: "/list", element: <PreviewList /> },
  { path: "/admin", element: <AdminWelcome /> },
  { path: "/admin/products", element: <PreviewList /> },
  previewFormRoute("/admin/products/new", <PreviewForm />),
  previewFormRoute("/form", <PreviewForm />),
  previewFormRoute("/error", <PreviewForm error />),
]);

createRoot(document.getElementById("root")!).render(
  <RouterProvider router={router} />,
);
