// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, redirect, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProductForm } from "./product-form";

let root: Root;

function formRouter(action = vi.fn(() => redirect("/done"))) {
  const router = createMemoryRouter(
    [
      {
        path: "/edit",
        element: (
          <ProductForm
            categories={[]}
            initial={{
              name: "Original",
              price: "29.95",
              categoryId: "",
              material: "",
              colour: "",
              description: "",
              sku: "",
              quantity: "",
              facebookUrl: "",
            }}
            version={100}
            status="draft"
          />
        ),
        action,
      },
      { path: "/done", element: <p>Saved product</p> },
      { path: "/admin/products", element: <p>Product list</p> },
    ],
    { initialEntries: ["/edit"] },
  );
  return { router, action };
}

async function editName() {
  const input = document.querySelector(
    'input[name="name"]',
  ) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, "Changed name");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  document.body.innerHTML = '<div id="test-root"></div>';
  root = createRoot(document.getElementById("test-root")!);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("product form navigation warning", () => {
  it("submits an edited form without a leave warning", async () => {
    const confirm = vi.fn().mockReturnValue(false);
    window.confirm = confirm;
    const { router, action } = formRouter();
    await act(async () => root.render(<RouterProvider router={router} />));
    await editName();
    await act(async () => {
      (
        document.querySelector('button[value="save"]') as HTMLButtonElement
      ).click();
    });
    expect(action).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe("/done");
    expect(document.body.textContent).toContain("Saved product");
  });

  it("warns when leaving dirty edits and keeps them after a cancelled Archive", async () => {
    const confirm = vi.fn().mockReturnValue(false);
    window.confirm = confirm;
    const { router, action } = formRouter();
    await act(async () => root.render(<RouterProvider router={router} />));
    await editName();
    await act(async () => {
      (
        document.querySelector('button[value="archive"]') as HTMLButtonElement
      ).click();
    });
    expect(confirm).toHaveBeenCalledWith(
      "Archive this product? It will move out of the normal product list.",
    );
    expect(action).not.toHaveBeenCalled();
    expect(
      (document.querySelector('input[name="name"]') as HTMLInputElement).value,
    ).toBe("Changed name");
    await act(async () => {
      (
        document.querySelector('a[href="/admin/products"]') as HTMLAnchorElement
      ).click();
    });
    expect(confirm).toHaveBeenCalledWith("Leave without saving your changes?");
    expect(router.state.location.pathname).toBe("/edit");
  });
});
