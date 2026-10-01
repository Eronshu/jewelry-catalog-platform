import type { ReactNode } from "react";
import { Link, useActionData } from "react-router";

import { AdminShell } from "../../app/components/admin/admin-shell";
import { ProductForm } from "../../app/components/admin/product-form";

const categories = [
  { id: 1, name: "Earrings", slug: "earrings", sortOrder: 0, isActive: true },
  { id: 4, name: "Rings", slug: "rings", sortOrder: 3, isActive: true },
];

export function PreviewLinks() {
  return (
    <nav aria-label="Preview scenes" className="admin-nav">
      <Link to="/">Welcome</Link>
      <Link to="/list">List</Link>
      <Link to="/form">Form</Link>
      <Link to="/error">Form errors</Link>
    </nav>
  );
}

export function PreviewForm({ error = false }: { error?: boolean }) {
  const actionData = useActionData<{ previewMessage?: string }>();
  return (
    <AdminShell>
      <PreviewLinks />
      <div className="admin-page-heading">
        <div>
          <h1>Add product</h1>
          <p>Save a Draft to get started.</p>
        </div>
      </div>
      {actionData?.previewMessage && (
        <p className="admin-preview-notice" role="status">
          {actionData.previewMessage}
        </p>
      )}
      <ProductForm
        categories={categories}
        requestKey="preview-only"
        feedback={
          error
            ? {
                error: "Please correct the highlighted fields.",
                fieldErrors: {
                  name: "Enter a name of up to 120 characters.",
                  price: "Enter a CAD price with up to two decimal places.",
                },
                fields: {
                  name: "",
                  price: "12.999",
                  categoryId: "4",
                  material: "Silver",
                  colour: "",
                  description: "",
                  sku: "",
                  quantity: "",
                  facebookUrl: "",
                },
              }
            : undefined
        }
      />
    </AdminShell>
  );
}

export function previewFormRoute(path: string, element: ReactNode) {
  return {
    path,
    element,
    action: () => ({
      previewMessage: "This is a visual preview. No product was saved.",
    }),
  };
}
