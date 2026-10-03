// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryRouter,
  RouterContextProvider,
  RouterProvider,
  useActionData,
  useLoaderData,
} from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cloudflareContext } from "../cloudflare-context";
import { adminPrincipalContext } from "../lib/auth/admin-access.server";
import {
  changeProduct,
  createDraft,
  findCreationRequest,
} from "../lib/db/admin-products.server";
import EditProduct, { action as editAction } from "./admin-product-edit";
import NewProduct from "./admin-product-new";
import { action as createAction } from "./admin-product-create";

vi.mock("../lib/auth/admin-mutation.server", () => ({
  readAdminForm: (request: Request) => request.formData(),
}));

vi.mock("../lib/db/admin-products.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/db/admin-products.server")>()),
  createDraft: vi.fn(),
  findCreationRequest: vi.fn(),
  changeProduct: vi.fn(),
}));

let root: Root;
let actionResult: unknown;

const categories = [
  { id: 1, name: "Rings", slug: "rings", sortOrder: 0, isActive: true },
];
const fields = {
  name: "Original name",
  price: "29.95",
  categoryId: "1",
  material: "",
  colour: "",
  description: "",
  sku: "",
  quantity: "",
  facebookUrl: "",
};

function context() {
  const value = new RouterContextProvider();
  value.set(adminPrincipalContext, {
    email: "owner@example.invalid",
    sub: "synthetic",
  });
  value.set(cloudflareContext, {
    env: { DB: {} } as Env,
    ctx: {} as ExecutionContext,
  });
  return value;
}

function NewPage() {
  return (
    <NewProduct
      {...({
        loaderData: useLoaderData(),
        actionData: useActionData(),
      } as Parameters<typeof NewProduct>[0])}
    />
  );
}

function EditPage() {
  return (
    <EditProduct
      {...({
        loaderData: useLoaderData(),
        actionData: useActionData(),
      } as Parameters<typeof EditProduct>[0])}
    />
  );
}

async function changeName() {
  const input = document.querySelector(
    'input[name="name"]',
  ) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, "Owner entered value");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function save() {
  await act(async () => {
    (
      document.querySelector(
        'button[value="create"], button[value="save"]',
      ) as HTMLButtonElement
    ).click();
  });
}

beforeEach(() => {
  document.body.innerHTML = '<div id="test-root"></div>';
  root = createRoot(document.getElementById("test-root")!);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.confirm = vi.fn().mockReturnValue(false);
  actionResult = undefined;
  sessionStorage.clear();
  vi.clearAllMocks();
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  sessionStorage.clear();
});

describe("operational product save failures", () => {
  it("keeps Create values and its request key for an idempotent retry", async () => {
    vi.mocked(createDraft)
      .mockRejectedValueOnce(new Error("private SQL details"))
      .mockResolvedValueOnce(91);
    vi.mocked(findCreationRequest).mockResolvedValue({
      id: 91,
      status: "draft",
      version: 100,
      businessVersion: 100,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, options: { body: URLSearchParams }) => {
        actionResult = await createAction({
          request: new Request(
            "https://example.invalid/admin/products/new/create",
            {
              method: "POST",
              headers: {
                Origin: "https://example.invalid",
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: options.body,
            },
          ),
          context: context(),
        } as never);
        const reply = actionResult as {
          data: unknown;
          init?: { status?: number };
        };
        return new Response(JSON.stringify(reply.data), {
          status: reply.init?.status ?? 200,
        });
      }),
    );
    const router = createMemoryRouter(
      [
        {
          path: "/admin/products/new",
          loader: () => ({ categories, requestKey: crypto.randomUUID() }),
          element: <NewPage />,
        },
        { path: "/admin/products/91/edit", element: <p>Created Draft</p> },
      ],
      { initialEntries: ["/admin/products/new"] },
    );
    await act(async () => root.render(<RouterProvider router={router} />));
    const originalKey = (
      document.querySelector('input[name="requestKey"]') as HTMLInputElement
    ).value;
    await changeName();
    await save();
    expect(actionResult).toMatchObject({
      init: {
        status: 503,
        headers: { "Cache-Control": "private, no-store" },
      },
    });
    expect(document.querySelector("form.admin-product-form")).not.toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not confirm the Draft",
    );
    expect(document.body.textContent).not.toContain("private SQL details");
    expect(
      (document.querySelector('input[name="name"]') as HTMLInputElement).value,
    ).toBe("Owner entered value");
    expect(
      (document.querySelector('input[name="requestKey"]') as HTMLInputElement)
        .value,
    ).toBe(originalKey);
    await act(async () => {
      (
        Array.from(document.querySelectorAll("button")).find(
          (item) => item.textContent?.trim() === "Retry saving Draft",
        ) as HTMLButtonElement
      ).click();
    });
    expect(vi.mocked(createDraft).mock.calls.map((call) => call[2])).toEqual([
      originalKey,
      originalKey,
    ]);
    expect(router.state.location.pathname).toBe("/admin/products/91/edit");
    expect(document.body.textContent).toContain("Created Draft");
  });

  it("keeps Edit values and version for a retry", async () => {
    vi.mocked(changeProduct)
      .mockRejectedValueOnce(new Error("private D1 details"))
      .mockResolvedValueOnce(101);
    const router = createMemoryRouter(
      [
        {
          path: "/admin/products/:productId/edit",
          loader: () => ({
            categories,
            fields,
            photoCount: 0,
            success: false,
            product: { name: "Original name", status: "draft", updatedAt: 100 },
          }),
          element: <EditPage />,
          action: async ({ request, params }) => {
            actionResult = await editAction({
              request,
              params,
              context: context(),
            } as never);
            return actionResult;
          },
        },
      ],
      { initialEntries: ["/admin/products/4/edit"] },
    );
    await act(async () => root.render(<RouterProvider router={router} />));
    await changeName();
    await save();
    expect(actionResult).toMatchObject({
      init: {
        status: 503,
        headers: { "Cache-Control": "private, no-store" },
      },
    });
    expect(document.querySelector("form.admin-product-form")).not.toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not save this product",
    );
    expect(document.body.textContent).not.toContain("private D1 details");
    expect(
      (document.querySelector('input[name="name"]') as HTMLInputElement).value,
    ).toBe("Owner entered value");
    expect(
      (document.querySelector('input[name="version"]') as HTMLInputElement)
        .value,
    ).toBe("100");
    await save();
    expect(vi.mocked(changeProduct).mock.calls.map((call) => call[2])).toEqual([
      100, 100,
    ]);
    expect(router.state.location.search).toBe("?message=saved");
  });
});
