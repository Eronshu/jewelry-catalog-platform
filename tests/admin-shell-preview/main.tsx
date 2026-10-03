import { createRoot } from "react-dom/client";
import { createBrowserRouter, Link, RouterProvider } from "react-router";

import "../../app/app.css";
import {
  AdminShell,
  AdminWelcome,
} from "../../app/components/admin/admin-shell";
import { PreviewForm, PreviewLinks, previewFormRoute } from "./preview-form";
import { ProductPhotos } from "../../app/components/admin/product-photos";

const fixtureImages = [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="#eee7dd"/><ellipse cx="200" cy="239" rx="82" ry="105" fill="none" stroke="#aaa7a2" stroke-width="27"/><path d="M160 145 200 78l40 67-40 45z" fill="#ded7e5" stroke="#aaa7a2" stroke-width="8"/></svg>`,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="#eae3d9"/><ellipse cx="200" cy="300" rx="132" ry="128" fill="none" stroke="#aaa7a2" stroke-width="32"/><path d="M118 172 200 45l82 127-82 91z" fill="#ded7e5" stroke="#aaa7a2" stroke-width="10"/></svg>`,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="#ebe8e3"/><circle cx="200" cy="210" r="115" fill="none" stroke="#9e9ba1" stroke-width="25"/><circle cx="200" cy="85" r="30" fill="#d8d0df" stroke="#9e9ba1" stroke-width="8"/></svg>`,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="#ece2da"/><path d="M75 125q125 245 250 0" fill="none" stroke="#a5a0a5" stroke-width="27"/><circle cx="200" cy="300" r="34" fill="#d9d0e0" stroke="#a5a0a5" stroke-width="8"/></svg>`,
];
let fixtureVersion = 100;
let fixturePhotos = [
  {
    id: 1,
    altText: "Silver ring on a cream background",
    sortOrder: 0,
    width: 400,
    height: 400,
  },
  {
    id: 2,
    altText: "Detail of the ring setting",
    sortOrder: 1,
    width: 400,
    height: 400,
  },
  {
    id: 3,
    altText: "Silver circle and lilac stone",
    sortOrder: 2,
    width: 400,
    height: 400,
  },
  {
    id: 4,
    altText: "Pendant detail on a warm backdrop",
    sortOrder: 3,
    width: 400,
    height: 400,
  },
];

function PreviewPhotos() {
  return (
    <AdminShell>
      <PreviewLinks />
      <div className="admin-page-heading">
        <div>
          <h1>Photo management visual fixture</h1>
          <p>
            Presentation only. Changes stay in this browser view; no product or
            photo is uploaded or saved. Try selected-photo layout on the Form
            scene.
          </p>
        </div>
      </div>
      <ProductPhotos
        productId={4}
        status="draft"
        version={fixtureVersion}
        businessVersion={100}
        onVersion={() => {}}
        initialPhotos={fixturePhotos}
        hidePicker
        previewUrlForPhoto={(_, photoId) =>
          `data:image/svg+xml,${encodeURIComponent(fixtureImages[photoId - 1])}`
        }
      />
    </AdminShell>
  );
}

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
  { path: "/photos", element: <PreviewPhotos /> },
  {
    path: "/admin/products/4/photos",
    action: async ({ request }) => {
      const form = await request.formData();
      if (form.get("intent") !== "reorder")
        return { error: "Only photo reordering is simulated here." };
      const ids = String(form.get("order")).split(",").map(Number);
      if (
        ids.length !== fixturePhotos.length ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !fixturePhotos.some((photo) => photo.id === id))
      )
        return { error: "Choose the preview photos to reorder." };
      fixturePhotos = ids.map((id, sortOrder) => ({
        ...fixturePhotos.find((photo) => photo.id === id)!,
        sortOrder,
      }));
      fixtureVersion += 1;
      return {
        version: fixtureVersion,
        businessVersion: 100,
        photos: fixturePhotos,
      };
    },
  },
  {
    path: "/admin/products/4/photos/:photoId",
    action: async ({ request, params }) => {
      const form = await request.formData();
      const id = Number(params.photoId);
      const photo = fixturePhotos.find((item) => item.id === id);
      if (!photo) return { error: "Preview photo not found." };
      if (form.get("intent") === "alt") {
        fixturePhotos = fixturePhotos.map((item) =>
          item.id === id
            ? { ...item, altText: String(form.get("altText")) }
            : item,
        );
      } else if (form.get("intent") === "remove") {
        fixturePhotos = fixturePhotos
          .filter((item) => item.id !== id)
          .map((item, sortOrder) => ({ ...item, sortOrder }));
      } else return { error: "This preview action is unavailable." };
      fixtureVersion += 1;
      return {
        version: fixtureVersion,
        businessVersion: 100,
        photos: fixturePhotos,
      };
    },
  },
]);

createRoot(document.getElementById("root")!).render(
  <RouterProvider router={router} />,
);
