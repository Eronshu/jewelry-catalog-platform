// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryRouter,
  RouterContextProvider,
  RouterProvider,
  useLoaderData,
} from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { adminPrincipalContext } from "../lib/auth/admin-access.server";
import { cloudflareContext } from "../cloudflare-context";
import { changeProduct } from "../lib/db/admin-products.server";
import { ProductForm } from "../components/admin/product-form";
import AdminProducts, { action } from "./admin-products";

vi.mock("../lib/auth/admin-mutation.server", () => ({
  readAdminForm: vi.fn().mockImplementation(async () => {
    const form = new FormData();
    form.set("productId", "1");
    form.set("version", "100");
    form.set("intent", "archive");
    return form;
  }),
}));

vi.mock("../lib/db/admin-products.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/db/admin-products.server")>()),
  changeProduct: vi.fn().mockResolvedValue(101),
}));

let root: Root;

const item = {
  id: 1,
  name: "Fictional Ring",
  sku: null,
  priceCents: 2995,
  status: "hidden" as const,
  updatedAt: 100,
  categoryName: "Rings",
  coverId: null,
  requestKey: crypto.randomUUID(),
};

function ListPage() {
  const loaderData = useLoaderData();
  const props = { loaderData, actionData: undefined } as unknown as Parameters<
    typeof AdminProducts
  >[0];
  return <AdminProducts {...props} />;
}

beforeEach(() => {
  document.body.innerHTML = '<div id="test-root"></div>';
  root = createRoot(document.getElementById("test-root")!);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("admin product navigation", () => {
  it("keeps validated filters after a quick action and resets controls on Clear", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/admin/products",
          loader: ({ request }) => {
            const url = new URL(request.url);
            return {
              items: [item],
              q: url.searchParams.get("q") ?? "",
              status: url.searchParams.get("status") ?? "all",
              nextCursor: null,
              success: url.searchParams.get("message") === "updated",
            };
          },
          element: <ListPage />,
          hydrateFallbackElement: <p>Loading</p>,
        },
      ],
      { initialEntries: ["/admin/products?q=Ring&status=hidden&cursor=100:1"] },
    );
    await act(async () => root.render(<RouterProvider router={router} />));
    const search = () =>
      document.querySelector('input[name="q"]') as HTMLInputElement;
    const status = () =>
      document.querySelector(
        'select[name="status"]',
      ) as unknown as HTMLSelectElement;
    expect(search().value).toBe("Ring");
    expect(status().value).toBe("hidden");
    expect(
      (
        document.querySelector(".admin-row-actions form") as HTMLFormElement
      ).getAttribute("action"),
    ).toBe("/admin/products?q=Ring&status=hidden");
    expect(
      (document.querySelector('button[value="publish"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(document.body.textContent).toContain(
      "Add a photo before showing this product",
    );

    const context = new RouterContextProvider();
    context.set(adminPrincipalContext, {
      email: "owner@example.invalid",
      sub: "synthetic",
    });
    context.set(cloudflareContext, {
      env: {} as Env,
      ctx: {} as ExecutionContext,
    });
    const mutationRequest = new Request(
      "https://example.invalid/admin/products?q=Ring&status=hidden&cursor=100:1",
      {
        method: "POST",
      },
    );
    const response = await action({
      context,
      request: mutationRequest,
    } as never);
    expect(response).toBeInstanceOf(Response);
    expect(vi.mocked(changeProduct)).toHaveBeenCalledWith(
      expect.anything(),
      1,
      100,
      "archive",
    );
    const location = (response as Response).headers.get("Location")!;
    expect(location).toBe(
      "/admin/products?message=updated&q=Ring&status=hidden",
    );
    await act(async () => router.navigate(location));
    expect(search().value).toBe("Ring");
    expect(status().value).toBe("hidden");
    expect(document.body.textContent).toContain("Product updated.");

    search().value = "Changed without submitting";
    await act(async () =>
      router.navigate("/admin/products?q=Hoop&status=draft"),
    );
    expect(search().value).toBe("Hoop");
    expect(status().value).toBe("draft");
    await act(async () =>
      (document.querySelector(".admin-filters a") as HTMLAnchorElement).click(),
    );
    expect(router.state.location.pathname).toBe("/admin/products");
    expect(router.state.location.search).toBe("");
    expect(search().value).toBe("");
    expect(status().value).toBe("all");
  });

  it("explains disabled publication on a zero-photo Draft edit form", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/edit",
          element: (
            <ProductForm
              categories={[
                {
                  id: 4,
                  name: "Rings",
                  slug: "rings",
                  sortOrder: 0,
                  isActive: true,
                },
              ]}
              initial={{
                name: "Fictional copy",
                price: "29.95",
                categoryId: "4",
                material: "",
                colour: "",
                description: "",
                sku: "",
                quantity: "",
                facebookUrl: "",
              }}
              version={100}
              status="draft"
              photoCount={0}
            />
          ),
        },
      ],
      { initialEntries: ["/edit"] },
    );
    await act(async () => root.render(<RouterProvider router={router} />));
    expect(
      (document.querySelector('button[value="publish"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (document.querySelector('button[value="mark-sold"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(document.body.textContent).toContain(
      "Add a photo before showing this product",
    );
  });
});
