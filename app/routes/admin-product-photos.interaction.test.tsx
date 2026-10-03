// @vitest-environment happy-dom
import { act, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryRouter,
  data,
  redirect,
  RouterContextProvider,
  RouterProvider,
  useActionData,
  useLoaderData,
} from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudflareContext } from "../cloudflare-context";
import { adminPrincipalContext } from "../lib/auth/admin-access.server";
import * as photoDb from "../lib/db/admin-product-photos.server";
import { ProductPhotos } from "../components/admin/product-photos";
import EditProduct, { shouldRevalidate } from "./admin-product-edit";
import { action as reorderAction } from "./admin-product-photos";

let root: Root;
type Photo = (typeof initialPhotos)[number];
type Snapshot = { version: number; businessVersion: number; photos: Photo[] };
const initialPhotos = [
  { id: 10, altText: "First photo", sortOrder: 0, width: 64, height: 64 },
  { id: 11, altText: "Second photo", sortOrder: 1, width: 64, height: 64 },
];
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
beforeEach(() => {
  document.body.innerHTML = '<div id="test-root"></div>';
  root = createRoot(document.getElementById("test-root")!);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let preview = 0;
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: () => `blob:preview-${++preview}`,
      revokeObjectURL: vi.fn(),
    }),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("real-router product and photo interaction", () => {
  it("shows a visible fallback while keeping saved-photo identity and actions after preview failure", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/edit",
          element: (
            <ProductPhotos
              productId={4}
              status="draft"
              initialPhotos={initialPhotos}
              version={100}
              businessVersion={100}
              onVersion={() => {}}
            />
          ),
        },
      ],
      { initialEntries: ["/edit"] },
    );
    await act(async () => root.render(<RouterProvider router={router} />));
    const row = document.querySelector('[data-photo-id="10"]') as HTMLElement;
    await act(async () => {
      row.querySelector("img")!.dispatchEvent(new Event("error"));
    });
    expect(row.querySelector("img")).toBeNull();
    expect(row.querySelector('[role="img"]')?.textContent).toBe(
      "Preview unavailable",
    );
    expect(row.textContent).toContain("Saved 1");
    expect(row.textContent).toContain("First photo");
    expect(
      row.querySelector('button[aria-label="Drag photo 1 to reorder"]'),
    ).toBeTruthy();
    expect(
      Array.from(row.querySelectorAll("button")).map(
        (item) => item.textContent,
      ),
    ).toContain("Remove photo");
    expect(row.textContent).not.toContain("products/4");
  });

  it("reorders selected files before the Add product upload begins", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/new",
          element: (
            <ProductPhotos
              productId={null}
              status="draft"
              initialPhotos={[]}
              version={1}
              businessVersion={1}
              onVersion={() => {}}
              createMode
            />
          ),
        },
      ],
      { initialEntries: ["/new"] },
    );
    await act(async () => root.render(<RouterProvider router={router} />));
    await act(async () =>
      pickFiles([makeFile("front.png"), makeFile("detail.png")]),
    );
    const handle = document.querySelector(
      'button[aria-label="Drag detail.png to reorder"]',
    ) as HTMLButtonElement;
    handle.setPointerCapture = vi.fn();
    vi.spyOn(document, "elementFromPoint").mockReturnValue(
      document.querySelector(".admin-photo-card"),
    );
    await act(async () => {
      for (const type of ["pointerdown", "pointermove", "pointerup"])
        handle.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerId: 1,
            pointerType: "touch",
          }),
        );
    });
    expect(
      Array.from(document.querySelectorAll(".admin-photo-card strong")).map(
        (item) => item.textContent,
      ),
    ).toEqual(["detail.png", "front.png"]);
  });

  it("opens the picker only from Add photos and saves a pointer reorder", async () => {
    const orders: string[] = [];
    const router = createMemoryRouter(
      [
        {
          path: "/edit",
          element: (
            <ProductPhotos
              productId={4}
              status="draft"
              initialPhotos={initialPhotos}
              version={100}
              businessVersion={100}
              onVersion={() => {}}
            />
          ),
        },
        {
          path: "/admin/products/4/photos",
          action: async ({ request }) => {
            const form = await request.formData();
            orders.push(String(form.get("order")));
            return {
              version: 101,
              businessVersion: 100,
              photos: [initialPhotos[1], initialPhotos[0]],
            };
          },
        },
      ],
      { initialEntries: ["/edit"] },
    );
    await act(async () => root.render(<RouterProvider router={router} />));
    const picker = document.querySelector("#photo-picker") as HTMLInputElement;
    const open = vi.spyOn(picker, "click").mockImplementation(() => {});
    await act(async () => {
      (document.querySelector(".admin-photo-picker") as HTMLElement).click();
    });
    expect(open).not.toHaveBeenCalled();
    await act(async () => {
      (
        Array.from(document.querySelectorAll("button")).find(
          (button) => button.textContent?.trim() === "Add photos",
        ) as HTMLButtonElement
      ).click();
    });
    expect(open).toHaveBeenCalledOnce();
    const handle = document.querySelector(
      'button[aria-label="Drag photo 2 to reorder"]',
    ) as HTMLButtonElement;
    handle.setPointerCapture = vi.fn();
    vi.spyOn(document, "elementFromPoint").mockReturnValue(
      document.querySelector('[data-photo-id="10"]'),
    );
    await act(async () => {
      handle.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          pointerId: 1,
          pointerType: "touch",
        }),
      );
      handle.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          pointerId: 1,
          pointerType: "touch",
        }),
      );
      handle.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          pointerId: 1,
          pointerType: "touch",
        }),
      );
    });
    expect(orders).toEqual(["11,10"]);
    expect(document.body.textContent).toContain("Cover photo");
  });

  it("ignores other pointers and clears selected and saved drag feedback on capture loss or cancel", async () => {
    const orders: string[] = [];
    const router = createMemoryRouter(
      [
        {
          path: "/new",
          element: (
            <ProductPhotos
              key="new-drag-test"
              productId={null}
              status="draft"
              initialPhotos={[]}
              version={1}
              businessVersion={1}
              onVersion={() => {}}
              createMode
            />
          ),
        },
        {
          path: "/edit",
          element: (
            <ProductPhotos
              key="edit-drag-test"
              productId={4}
              status="draft"
              initialPhotos={initialPhotos}
              version={100}
              businessVersion={100}
              onVersion={() => {}}
            />
          ),
        },
        {
          path: "/admin/products/4/photos",
          action: async ({ request }) => {
            orders.push(String((await request.formData()).get("order")));
            return {
              version: 101,
              businessVersion: 100,
              photos: [initialPhotos[1], initialPhotos[0]],
            };
          },
        },
      ],
      { initialEntries: ["/new"] },
    );
    await act(async () => root.render(<RouterProvider router={router} />));
    await act(async () =>
      pickFiles([makeFile("front.png"), makeFile("detail.png")]),
    );
    const selected = document.querySelector(
      'button[aria-label="Drag detail.png to reorder"]',
    ) as HTMLButtonElement;
    selected.setPointerCapture = vi.fn();
    vi.spyOn(document, "elementFromPoint").mockReturnValue(
      document.querySelector("[data-pending-id]"),
    );
    const dispatch = (handle: HTMLElement, type: string, pointerId: number) =>
      handle.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerId,
          pointerType: "touch",
        }),
      );
    await act(async () => {
      dispatch(selected, "pointerdown", 7);
      dispatch(selected, "pointermove", 8);
      dispatch(selected, "pointerup", 8);
    });
    expect(document.querySelectorAll(".admin-photo-drag-target")).toHaveLength(
      0,
    );
    expect(document.querySelectorAll(".admin-photo-dragging")).toHaveLength(1);
    await act(async () => {
      dispatch(selected, "pointermove", 7);
      dispatch(selected, "lostpointercapture", 7);
      dispatch(selected, "pointerup", 7);
    });
    expect(
      document.querySelectorAll(
        ".admin-photo-dragging, .admin-photo-drag-target",
      ),
    ).toHaveLength(0);
    expect(
      Array.from(document.querySelectorAll("[data-pending-id] strong")).map(
        (item) => item.textContent,
      ),
    ).toEqual(["front.png", "detail.png"]);
    await act(async () => {
      dispatch(selected, "pointerdown", 9);
      dispatch(selected, "pointermove", 9);
      dispatch(selected, "pointercancel", 9);
      dispatch(selected, "pointerup", 9);
    });
    expect(
      document.querySelectorAll(
        ".admin-photo-dragging, .admin-photo-drag-target",
      ),
    ).toHaveLength(0);
    await act(async () => router.navigate("/edit"));
    const saved = document.querySelector(
      'button[aria-label="Drag photo 2 to reorder"]',
    ) as HTMLButtonElement;
    saved.setPointerCapture = vi.fn();
    vi.spyOn(document, "elementFromPoint").mockReturnValue(
      document.querySelector('[data-photo-id="10"]'),
    );
    await act(async () => {
      dispatch(saved, "pointerdown", 11);
      dispatch(saved, "pointermove", 11);
      dispatch(saved, "pointerup", 12);
      dispatch(saved, "lostpointercapture", 11);
      dispatch(saved, "pointerup", 11);
    });
    expect(orders).toEqual([]);
    expect(
      document.querySelectorAll(
        ".admin-photo-dragging, .admin-photo-drag-target",
      ),
    ).toHaveLength(0);
    await act(async () => {
      dispatch(saved, "pointerdown", 13);
      dispatch(saved, "pointermove", 13);
      dispatch(saved, "pointerup", 13);
    });
    expect(orders).toEqual(["11,10"]);
  });

  it("cancels a saved drag when actions become disabled or the editor unmounts", async () => {
    const orders: string[] = [];
    function Harness() {
      const [archived, setArchived] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setArchived(true)}>
            Disable photo actions
          </button>
          <button type="button" onClick={() => setArchived(false)}>
            Enable photo actions
          </button>
          <ProductPhotos
            productId={4}
            status={archived ? "archived" : "draft"}
            initialPhotos={initialPhotos}
            version={100}
            businessVersion={100}
            onVersion={() => {}}
          />
        </>
      );
    }
    const router = createMemoryRouter(
      [
        { path: "/edit", element: <Harness /> },
        { path: "/done", element: <p>Done</p> },
        {
          path: "/admin/products/4/photos",
          action: async ({ request }) => {
            orders.push(String((await request.formData()).get("order")));
            return {
              version: 101,
              businessVersion: 100,
              photos: [initialPhotos[1], initialPhotos[0]],
            };
          },
        },
      ],
      { initialEntries: ["/edit"] },
    );
    await act(async () => root.render(<RouterProvider router={router} />));
    const handle = document.querySelector(
      'button[aria-label="Drag photo 2 to reorder"]',
    ) as HTMLButtonElement;
    handle.setPointerCapture = vi.fn();
    vi.spyOn(document, "elementFromPoint").mockReturnValue(
      document.querySelector('[data-photo-id="10"]'),
    );
    const pointer = (type: string, id: number) =>
      handle.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerId: id,
          pointerType: "touch",
        }),
      );
    await act(async () => {
      pointer("pointerdown", 3);
      pointer("pointermove", 3);
    });
    expect(
      document.querySelectorAll(
        ".admin-photo-dragging, .admin-photo-drag-target",
      ),
    ).toHaveLength(2);
    await act(async () => button("Disable photo actions").click());
    expect(
      document.querySelectorAll(
        ".admin-photo-dragging, .admin-photo-drag-target",
      ),
    ).toHaveLength(0);
    await act(async () => pointer("pointerup", 3));
    expect(orders).toEqual([]);
    await act(async () => button("Enable photo actions").click());
    await act(async () => {
      pointer("pointerdown", 4);
      pointer("pointermove", 4);
    });
    expect(
      document.querySelectorAll(
        ".admin-photo-dragging, .admin-photo-drag-target",
      ),
    ).toHaveLength(2);
    await act(async () => router.navigate("/done"));
    await act(async () => pointer("pointerup", 4));
    expect(orders).toEqual([]);
    expect(router.state.location.pathname).toBe("/done");
  });

  it("saves the intended order with the Move earlier and Move later fallback", async () => {
    const orders: string[] = [];
    let current = initialPhotos;
    let version = 100;
    const router = createMemoryRouter(
      [
        {
          path: "/edit",
          element: (
            <ProductPhotos
              productId={4}
              status="draft"
              initialPhotos={initialPhotos}
              version={100}
              businessVersion={100}
              onVersion={() => {}}
            />
          ),
        },
        {
          path: "/admin/products/4/photos",
          action: async ({ request }) => {
            const form = await request.formData();
            expect(form.get("version")).toBe(String(version));
            const ids = String(form.get("order")).split(",").map(Number);
            orders.push(ids.join(","));
            current = ids.map((id, sortOrder) => ({
              ...current.find((photo) => photo.id === id)!,
              sortOrder,
            }));
            version += 1;
            return { version, businessVersion: 100, photos: current };
          },
        },
      ],
      { initialEntries: ["/edit"] },
    );
    await act(async () => root.render(<RouterProvider router={router} />));
    await act(async () => {
      (
        document.querySelector(
          'button[aria-label="Move photo 2 earlier"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(orders).toEqual(["11,10"]);
    expect(document.body.textContent).toContain("Photo order saved");
    expect(
      document.querySelector("[data-photo-id='11'] strong")?.textContent,
    ).toBe("Cover photo");
    await act(async () => {
      (
        document.querySelector(
          'button[aria-label="Move photo 1 later"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(orders).toEqual(["11,10", "10,11"]);
    expect(
      document.querySelector("[data-photo-id='10'] strong")?.textContent,
    ).toBe("Cover photo");
  });

  it("keeps unsaved business edits through a photo reorder and saves with the advanced version", async () => {
    const saved: Array<[string, string]> = [];
    const router = createMemoryRouter(
      [
        {
          path: "/admin/products/4/edit",
          loader: () => ({
            categories: [
              {
                id: 4,
                name: "Rings",
                slug: "rings",
                sortOrder: 0,
                isActive: true,
              },
            ],
            fields: {
              name: "Original ring",
              price: "29.95",
              categoryId: "4",
              material: "",
              colour: "",
              description: "",
              sku: "",
              quantity: "",
              facebookUrl: "",
            },
            photos: initialPhotos,
            businessVersion: 100,
            success: false,
            product: {
              id: 4,
              name: "Original ring",
              status: "draft",
              updatedAt: 100,
            },
          }),
          element: <EditPage />,
          shouldRevalidate,
          action: async ({ request }) => {
            const form = await request.formData();
            saved.push([String(form.get("name")), String(form.get("version"))]);
            return redirect("/done");
          },
        },
        {
          path: "/admin/products/4/photos",
          action: async ({ request }) => {
            const form = await request.formData();
            expect(form.get("version")).toBe("100");
            expect(form.get("order")).toBe("11,10");
            return {
              version: 101,
              businessVersion: 100,
              photos: [initialPhotos[1], initialPhotos[0]],
            };
          },
        },
        { path: "/done", element: <p>Saved</p> },
      ],
      { initialEntries: ["/admin/products/4/edit"] },
    );
    await act(async () => root.render(<RouterProvider router={router} />));
    const name = document.querySelector(
      'input[name="name"]',
    ) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(name, "Owner's unsaved ring");
      name.dispatchEvent(new Event("input", { bubbles: true }));
      name.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      (
        document.querySelector(
          'button[aria-label="Move photo 2 earlier"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(
      (document.querySelector('input[name="name"]') as HTMLInputElement).value,
    ).toBe("Owner's unsaved ring");
    expect(
      (
        document.querySelector(
          'form.admin-product-form input[name="version"]',
        ) as HTMLInputElement
      ).value,
    ).toBe("101");
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    await act(async () => {
      await router.navigate("/done");
    });
    expect(confirm).toHaveBeenCalledWith("Leave without saving your changes?");
    expect(router.state.location.pathname).toBe("/admin/products/4/edit");
    await act(async () => {
      (
        document.querySelector('button[value="save"]') as HTMLButtonElement
      ).click();
    });
    expect(saved).toEqual([["Owner's unsaved ring", "101"]]);
    expect(router.state.location.pathname).toBe("/done");
  });
});

class FakeXHR {
  static sent: FakeXHR[] = [];
  headers = new Map<string, string>();
  upload: { onprogress?: (event: ProgressEvent) => void } = {};
  onload?: () => void;
  onerror?: () => void;
  status = 0;
  responseText = "";
  body?: File;
  open(method: string, url: string) {
    expect(method).toBe("POST");
    expect(url).toBe("/admin/products/4/photos/upload");
  }
  setRequestHeader(name: string, value: string) {
    this.headers.set(name, value);
  }
  send(body: File) {
    this.body = body;
    FakeXHR.sent.push(this);
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({
      lengthComputable: true,
      loaded,
      total,
    } as ProgressEvent);
  }
  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}

function makeFile(name: string) {
  const file = new File(["fixture"], name, { type: "image/png" });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new TextEncoder().encode("fixture").buffer,
  });
  return file;
}
function pickFiles(files: File[]) {
  const picker = document.querySelector("#photo-picker") as HTMLInputElement;
  Object.defineProperty(picker, "files", { configurable: true, value: files });
  picker.dispatchEvent(new Event("change", { bubbles: true }));
}
function typeName(value: string) {
  const name = document.querySelector('input[name="name"]') as HTMLInputElement;
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set?.call(name, value);
  name.dispatchEvent(new Event("input", { bubbles: true }));
  name.dispatchEvent(new Event("change", { bubbles: true }));
}
function button(label: string) {
  const found = Array.from(document.querySelectorAll("button")).find(
    (element) => element.textContent?.trim() === label,
  );
  expect(found, `button ${label}`).toBeTruthy();
  return found as HTMLButtonElement;
}
function fieldVersion() {
  return (
    document.querySelector(
      'form.admin-product-form input[name="version"]',
    ) as HTMLInputElement
  ).value;
}
async function flushUpload() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
async function renderScenario(options: {
  initialPhotos?: Photo[];
  photoAction?: (
    request: Request,
  ) => Promise<Snapshot | { error: string; code: string; status: number }>;
  serverVersion?: number;
  businessVersion?: number;
  initialEntries?: string[];
}) {
  let serverVersion = options.serverVersion ?? 100;
  const saved: Array<{ name: string; version: number }> = [];
  const photos = options.initialPhotos ?? [];
  const router = createMemoryRouter(
    [
      {
        path: "/admin/products/4/edit",
        loader: () => ({
          categories: [
            {
              id: 4,
              name: "Rings",
              slug: "rings",
              sortOrder: 0,
              isActive: true,
            },
          ],
          fields: {
            name: "Original ring",
            price: "29.95",
            categoryId: "4",
            material: "",
            colour: "",
            description: "",
            sku: "",
            quantity: "",
            facebookUrl: "",
          },
          photos,
          businessVersion: options.businessVersion ?? 100,
          success: false,
          product: {
            id: 4,
            name: "Original ring",
            status: "draft",
            updatedAt: 100,
          },
        }),
        element: <EditPage />,
        shouldRevalidate,
        action: async ({ request }) => {
          const form = await request.formData();
          const version = Number(form.get("version"));
          saved.push({ name: String(form.get("name")), version });
          if (version !== serverVersion)
            return data(
              {
                error: "This product changed. Refresh and try again.",
                version,
              },
              { status: 409 },
            );
          return redirect("/done");
        },
      },
      {
        path: "/admin/products/4/photos",
        action: async ({ request }) => {
          const result = await options.photoAction?.(request);
          if (!result)
            return {
              version: serverVersion,
              businessVersion: options.businessVersion ?? 100,
              photos,
            };
          if ("error" in result)
            return data(
              { error: result.error, code: result.code },
              { status: result.status },
            );
          serverVersion = result.version;
          return result;
        },
      },
      {
        path: "/admin/products/4/photos/10",
        action: async ({ request }) => {
          const result = await options.photoAction?.(request);
          if (!result) throw new Error("Missing photo action");
          if ("error" in result)
            return data(
              { error: result.error, code: result.code },
              { status: result.status },
            );
          serverVersion = result.version;
          return result;
        },
      },
      { path: "/admin/products", element: <p>Products list</p> },
      { path: "/done", element: <p>Saved</p> },
    ],
    { initialEntries: options.initialEntries ?? ["/admin/products/4/edit"] },
  );
  await act(async () => root.render(<RouterProvider router={router} />));
  return {
    router,
    saved,
    setServerVersion: (version: number) => {
      serverVersion = version;
    },
  };
}

describe("photo owner flows", () => {
  beforeEach(() => {
    FakeXHR.sent = [];
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
  });

  it("warns once for Back during an upload, keeps the editor on cancel, and leaves on confirmation", async () => {
    const { router } = await renderScenario({});
    await act(async () => {
      pickFiles([makeFile("waiting.png"), makeFile("queued.png")]);
    });
    await act(async () => {
      button("Upload ready photos").click();
    });
    await vi.waitFor(() => expect(FakeXHR.sent).toHaveLength(1));
    await act(async () => {
      FakeXHR.sent[0].progress(6, 6);
    });
    const confirm = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    vi.stubGlobal("confirm", confirm);
    const back = document.querySelector(
      'a[href="/admin/products"]',
    ) as HTMLAnchorElement;
    await act(async () => back.click());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(
      "Leave while a photo is uploading? The photo may still finish.",
    );
    expect(router.state.location.pathname).toBe("/admin/products/4/edit");
    expect(document.body.textContent).toContain("Finishing photo");
    expect(FakeXHR.sent).toHaveLength(1);
    await act(async () => back.click());
    expect(router.state.location.pathname).toBe("/admin/products");
    expect(document.body.textContent).toContain("Products list");
    expect(confirm).toHaveBeenCalledTimes(2);
    await act(async () => {
      FakeXHR.sent[0].respond(200, {
        version: 101,
        businessVersion: 100,
        photos: [initialPhotos[0]],
      });
    });
    expect(FakeXHR.sent).toHaveLength(1);
  });

  it("uses one warning for dirty fields and an upload during history navigation, then allows navigation after completion", async () => {
    const { router } = await renderScenario({
      initialEntries: ["/admin/products", "/admin/products/4/edit"],
    });
    await act(async () => {
      typeName("Unsaved owner title");
      pickFiles([makeFile("history.png")]);
      button("Upload ready photos").click();
      await flushUpload();
    });
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    await act(async () => {
      await router.navigate(-1);
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(
      "Leave while a photo is uploading and product changes are unsaved? The photo may still finish.",
    );
    expect(router.state.location.pathname).toBe("/admin/products/4/edit");
    expect(
      (document.querySelector('input[name="name"]') as HTMLInputElement).value,
    ).toBe("Unsaved owner title");
    await act(async () => {
      FakeXHR.sent[0].respond(200, {
        version: 101,
        businessVersion: 100,
        photos: [initialPhotos[0]],
      });
    });
    await act(async () => {
      await router.navigate(-1);
    });
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenLastCalledWith(
      "Leave without saving your changes?",
    );
    expect(router.state.location.pathname).toBe("/admin/products/4/edit");
  });

  it("does not warn for completed uploads or saved queue items", async () => {
    const { router } = await renderScenario({});
    await act(async () => {
      pickFiles([makeFile("complete.png")]);
      button("Upload ready photos").click();
      await flushUpload();
      FakeXHR.sent[0].respond(200, {
        version: 101,
        businessVersion: 100,
        photos: [initialPhotos[0]],
      });
    });
    expect(document.body.textContent).toContain("Saved");
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    await act(async () => {
      (
        document.querySelector('a[href="/admin/products"]') as HTMLAnchorElement
      ).click();
    });
    expect(router.state.location.pathname).toBe("/admin/products");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("confirms Save during an upload before sending it and retains the editor on cancel", async () => {
    const { router, saved } = await renderScenario({});
    await act(async () => {
      typeName("Save while uploading");
      pickFiles([makeFile("concurrent.png")]);
      button("Upload ready photos").click();
      await flushUpload();
    });
    const confirm = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    vi.stubGlobal("confirm", confirm);
    await act(async () => button("Save").click());
    expect(confirm).toHaveBeenCalledWith(
      "Save product details while a photo is uploading? Leaving or reloading this editor may hide the upload result. Check saved photos afterward.",
    );
    expect(saved).toEqual([]);
    expect(router.state.location.pathname).toBe("/admin/products/4/edit");
    expect(
      (document.querySelector('input[name="name"]') as HTMLInputElement).value,
    ).toBe("Save while uploading");
    expect(document.body.textContent).toContain("Uploading 0%");
    expect(
      document.querySelectorAll('img[alt="Local preview, not saved"]'),
    ).toHaveLength(1);
    expect(FakeXHR.sent).toHaveLength(1);
    await act(async () => {
      (
        document.querySelector('a[href="/admin/products"]') as HTMLAnchorElement
      ).click();
    });
    expect(confirm).toHaveBeenLastCalledWith(
      "Leave while a photo is uploading and product changes are unsaved? The photo may still finish.",
    );
    expect(router.state.location.pathname).toBe("/admin/products/4/edit");
    await act(async () => button("Save").click());
    expect(saved).toEqual([{ name: "Save while uploading", version: 100 }]);
    expect(router.state.location.pathname).toBe("/done");
    expect(confirm).toHaveBeenCalledTimes(3);
  });

  it("saves normally without an upload confirmation when no upload is active", async () => {
    const { saved, router } = await renderScenario({});
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    await act(async () => {
      typeName("Ordinary save");
      button("Save").click();
    });
    expect(saved).toEqual([{ name: "Ordinary save", version: 100 }]);
    expect(router.state.location.pathname).toBe("/done");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("shows two local previews and progress, then retries only the failed file", async () => {
    const { saved } = await renderScenario({});
    await act(async () => {
      typeName("Unsaved owner title");
      pickFiles([makeFile("one.png"), makeFile("two.png")]);
    });
    expect(
      document.querySelectorAll('img[alt="Local preview, not saved"]'),
    ).toHaveLength(2);
    expect(document.body.textContent).toContain("Not uploaded");
    await act(async () => {
      button("Upload ready photos").click();
      await flushUpload();
    });
    expect(FakeXHR.sent).toHaveLength(1);
    expect(FakeXHR.sent[0].body?.name).toBe("one.png");
    await act(async () => {
      FakeXHR.sent[0].progress(3, 6);
    });
    expect(document.body.textContent).toContain("Uploading 50%");
    await act(async () => {
      FakeXHR.sent[0].progress(6, 6);
    });
    expect(document.body.textContent).toContain("Finishing photo");
    await act(async () => {
      FakeXHR.sent[0].respond(200, {
        version: 101,
        businessVersion: 100,
        photos: [{ ...initialPhotos[0], id: 10 }],
      });
      await flushUpload();
    });
    expect(FakeXHR.sent).toHaveLength(2);
    expect(FakeXHR.sent[1].body?.name).toBe("two.png");
    await act(async () => {
      flushSync(() => {
        FakeXHR.sent[1].respond(503, {
          error: "Upload failed. Retry this photo.",
          code: "error",
        });
      });
      expect(button("Retry").disabled).toBe(true);
    });
    expect(document.body.textContent).toContain("Saved photos");
    expect(document.body.textContent).toContain(
      "Upload failed. Retry this photo.",
    );
    expect(button("Retry").disabled).toBe(false);
    const firstId = FakeXHR.sent[0].headers.get("X-Upload-Id");
    const failedId = FakeXHR.sent[1].headers.get("X-Upload-Id");
    await act(async () => {
      button("Retry").click();
      await flushUpload();
    });
    expect(FakeXHR.sent).toHaveLength(3);
    expect(FakeXHR.sent[2].body?.name).toBe("two.png");
    expect(FakeXHR.sent[2].headers.get("X-Upload-Id")).toBe(failedId);
    expect(FakeXHR.sent[2].headers.get("X-Upload-Id")).not.toBe(firstId);
    expect(FakeXHR.sent[2].headers.get("X-Product-Version")).toBe("101");
    await act(async () => {
      FakeXHR.sent[2].respond(200, {
        version: 102,
        businessVersion: 100,
        photos: initialPhotos,
      });
    });
    expect(fieldVersion()).toBe("102");
    expect(
      (document.querySelector('input[name="name"]') as HTMLInputElement).value,
    ).toBe("Unsaved owner title");
    await act(async () => {
      button("Save").click();
    });
    expect(saved).toEqual([{ name: "Unsaved owner title", version: 102 }]);
  });

  it("keeps an in-progress reservation retryable and advances the later business save", async () => {
    const { saved } = await renderScenario({});
    await act(async () => {
      typeName("In-progress title");
      pickFiles([makeFile("waiting.png")]);
    });
    await act(async () => {
      button("Upload ready photos").click();
      await flushUpload();
    });
    await act(async () => {
      FakeXHR.sent[0].respond(409, {
        error: "This photo is still uploading. Retry shortly.",
        code: "upload_in_progress",
      });
    });
    expect(document.body.textContent).toContain("still uploading");
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (item) => item.textContent?.trim() === "Refresh photos",
      ),
    ).toBe(false);
    await act(async () => {
      button("Retry").click();
      await flushUpload();
    });
    expect(FakeXHR.sent[1].headers.get("X-Upload-Id")).toBe(
      FakeXHR.sent[0].headers.get("X-Upload-Id"),
    );
    await act(async () => {
      FakeXHR.sent[1].respond(200, {
        version: 101,
        businessVersion: 100,
        photos: [initialPhotos[0]],
      });
    });
    expect(fieldVersion()).toBe("101");
    await act(async () => {
      button("Save").click();
    });
    expect(saved).toEqual([{ name: "In-progress title", version: 101 }]);
  });

  it("refreshes a real reorder route conflict and retries the intended order without losing an unsaved field", async () => {
    const context = new RouterContextProvider();
    context.set(adminPrincipalContext, {
      email: "owner@example.invalid",
      sub: "interaction",
    });
    context.set(cloudflareContext, {
      env: { DB: {} as D1Database } as Env,
      ctx: {} as ExecutionContext,
    });
    const reorder = vi
      .spyOn(photoDb, "reorderPhotos")
      .mockRejectedValueOnce(
        new photoDb.PhotoMutationError(
          "This product changed. Refresh photos and try again.",
          409,
          "stale_product",
        ),
      )
      .mockResolvedValueOnce({
        version: 102,
        businessVersion: 100,
        photos: [initialPhotos[1], initialPhotos[0]],
      });
    const { saved } = await renderScenario({
      initialPhotos,
      photoAction: async (request) => {
        const form = await request.formData();
        const body = new URLSearchParams();
        for (const [key, value] of form) body.append(key, String(value));
        // happy-dom omits forbidden Origin headers from Request, so supply the
        // browser request fields directly to exercise the real route action.
        const routeRequest = {
          method: "POST",
          url: "https://example.invalid/admin/products/4/photos",
          headers: {
            get: (name: string) =>
              ({
                origin: "https://example.invalid",
                "content-type": "application/x-www-form-urlencoded",
              })[name.toLowerCase() as "origin" | "content-type"] ?? null,
          },
          body: new Blob([body.toString()]).stream(),
        } as unknown as Request;
        const reply = (await reorderAction({
          request: routeRequest,
          context,
          params: { productId: "4" },
        } as unknown as Parameters<typeof reorderAction>[0])) as {
          data: Snapshot | { error: string; code: string };
          init?: { status?: number };
        };
        return "error" in reply.data
          ? { ...reply.data, status: reply.init?.status ?? 500 }
          : reply.data;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              version: 101,
              businessVersion: 100,
              photos: initialPhotos,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    await act(async () => {
      typeName("Unsaved through refresh");
      (
        Array.from(document.querySelectorAll("button")).filter(
          (element) => element.textContent?.trim() === "Make cover",
        )[1] as HTMLButtonElement
      ).click();
    });
    expect(document.body.textContent).toContain("Refresh photos");
    expect(reorder.mock.calls[0][2]).toBe(100);
    await act(async () => {
      button("Refresh photos").click();
      await flushUpload();
    });
    expect(fieldVersion()).toBe("101");
    expect(
      (document.querySelector('input[name="name"]') as HTMLInputElement).value,
    ).toBe("Unsaved through refresh");
    await act(async () => {
      (
        document.querySelector(
          'button[aria-label="Move photo 2 earlier"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(reorder.mock.calls[1][2]).toBe(101);
    expect(reorder.mock.calls[1][3]).toEqual([11, 10]);
    expect(fieldVersion()).toBe("102");
    await act(async () => {
      button("Save").click();
    });
    expect(saved).toEqual([{ name: "Unsaved through refresh", version: 102 }]);
  });

  it.each([
    "network rejection",
    "malformed response",
    "null photo entry",
    "invalid photo fields",
  ])(
    "keeps refresh available after a %s and recovers on retry",
    async (failure) => {
      const { saved } = await renderScenario({
        initialPhotos,
        photoAction: async () => ({
          error: "This product changed. Refresh photos and try again.",
          code: "stale_product",
          status: 409,
        }),
      });
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(
          failure === "network rejection"
            ? async () => {
                throw new Error("offline");
              }
            : failure === "malformed response"
              ? async () => new Response("{broken", { status: 200 })
              : async () =>
                  new Response(
                    JSON.stringify({
                      version: 101,
                      businessVersion: 100,
                      photos:
                        failure === "null photo entry"
                          ? [null]
                          : [
                              {
                                id: "10",
                                sortOrder: -1,
                                altText: null,
                                width: "64",
                                height: 64,
                              },
                            ],
                    }),
                    { status: 200 },
                  ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              version: 101,
              businessVersion: 100,
              photos: initialPhotos,
            }),
            { status: 200 },
          ),
        );
      vi.stubGlobal("fetch", fetchMock);
      await act(async () => {
        typeName("Keep this unsaved title");
        (
          document.querySelector(
            'button[aria-label="Move photo 2 earlier"]',
          ) as HTMLButtonElement
        ).click();
      });
      expect(document.body.textContent).toContain("Refresh photos");
      await act(async () => {
        button("Refresh photos").click();
        await flushUpload();
      });
      expect(document.body.textContent).toContain(
        "Could not refresh photos. Try again.",
      );
      expect(document.body.textContent).toContain("Refresh photos");
      expect(fieldVersion()).toBe("100");
      expect(
        document.querySelectorAll(".admin-photo-grid .admin-photo-card"),
      ).toHaveLength(2);
      expect(
        (document.querySelector('input[name="name"]') as HTMLInputElement)
          .value,
      ).toBe("Keep this unsaved title");
      await act(async () => {
        button("Refresh photos").click();
        await flushUpload();
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(document.body.textContent).toContain("Photos refreshed");
      expect(document.body.textContent).not.toContain("Refresh photos");
      expect(fieldVersion()).toBe("101");
      await act(async () => button("Save").click());
      expect(saved).toEqual([
        { name: "Keep this unsaved title", version: 101 },
      ]);
    },
  );

  it("edits alt text and removes a photo only after confirmation", async () => {
    const sent: Array<{
      intent: string;
      version: string;
      alt: string;
      path: string;
    }> = [];
    const { saved } = await renderScenario({
      initialPhotos,
      photoAction: async (request) => {
        const form = await request.formData();
        sent.push({
          intent: String(form.get("intent")),
          version: String(form.get("version")),
          alt: String(form.get("altText")),
          path: new URL(request.url).pathname,
        });
        return sent.length === 1
          ? {
              version: 101,
              businessVersion: 100,
              photos: [
                { ...initialPhotos[0], altText: "Silver ring on cream" },
                initialPhotos[1],
              ],
            }
          : { version: 102, businessVersion: 100, photos: [initialPhotos[1]] };
      },
    });
    await act(async () => {
      typeName("Owner title");
    });
    const alt = document.querySelector(
      '.admin-photo-card input[type="text"]',
    ) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(alt, "Silver ring on cream");
      alt.dispatchEvent(new Event("input", { bubbles: true }));
      alt.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      button("Save description").click();
    });
    expect(sent).toEqual([
      {
        intent: "alt",
        version: "100",
        alt: "Silver ring on cream",
        path: "/admin/products/4/photos/10",
      },
    ]);
    expect(
      (
        document.querySelector(
          '.admin-photo-card input[type="text"]',
        ) as HTMLInputElement
      ).value,
    ).toBe("Silver ring on cream");
    const confirm = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    vi.stubGlobal("confirm", confirm);
    await act(async () => {
      button("Remove photo").click();
    });
    expect(sent).toHaveLength(1);
    expect(confirm).toHaveBeenLastCalledWith(
      "Remove saved photo 1 of 2 (“Silver ring on cream”)? This cannot be undone.",
    );
    await act(async () => {
      button("Remove photo").click();
    });
    expect(confirm).toHaveBeenLastCalledWith(
      "Remove saved photo 1 of 2 (“Silver ring on cream”)? This cannot be undone.",
    );
    expect(sent[1]).toMatchObject({
      intent: "remove",
      version: "101",
      path: "/admin/products/4/photos/10",
    });
    expect(
      document.querySelectorAll(".admin-photo-grid .admin-photo-card"),
    ).toHaveLength(1);
    await act(async () => {
      button("Save").click();
    });
    expect(saved).toEqual([{ name: "Owner title", version: 102 }]);
  });

  it.each([
    { photoId: 10, altText: "   ", expected: "No description", position: 1 },
    {
      photoId: 11,
      altText: "Detail ".repeat(20),
      expected: `${"Detail ".repeat(11)}Det…`,
      position: 2,
    },
  ])(
    "identifies saved photo $position clearly when its description is empty or long",
    async ({ photoId, altText, expected, position }) => {
      const photos = initialPhotos.map((photo) =>
        photo.id === photoId ? { ...photo, altText } : photo,
      );
      const action = vi.fn(async () => ({
        version: 101,
        businessVersion: 100,
        photos,
      }));
      await renderScenario({ initialPhotos: photos, photoAction: action });
      const row = document.querySelector(
        `[data-photo-id="${photoId}"]`,
      ) as HTMLElement;
      const remove = Array.from(row.querySelectorAll("button")).find(
        (item) => item.textContent?.trim() === "Remove photo",
      ) as HTMLButtonElement;
      const confirm = vi.fn(() => false);
      vi.stubGlobal("confirm", confirm);
      await act(async () => remove.click());
      expect(confirm).toHaveBeenCalledWith(
        `Remove saved photo ${position} of 2 (“${expected}”)? This cannot be undone.`,
      );
      expect(action).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      label: "no later change",
      retryVersion: 101,
      businessVersion: 100,
      expectedFormVersion: "102",
      saveSucceeds: true,
    },
    {
      label: "later photo-only change",
      retryVersion: 102,
      businessVersion: 100,
      expectedFormVersion: "103",
      saveSucceeds: true,
    },
    {
      label: "later business edit",
      retryVersion: 102,
      businessVersion: 102,
      expectedFormVersion: "100",
      saveSucceeds: false,
    },
  ])(
    "uses the current photo snapshot after a committed retry with $label",
    async ({
      retryVersion,
      businessVersion,
      expectedFormVersion,
      saveSucceeds,
    }) => {
      const photoRequests: string[] = [];
      const { saved } = await renderScenario({
        initialPhotos,
        serverVersion: retryVersion,
        photoAction: async (request) => {
          const form = await request.formData();
          photoRequests.push(String(form.get("version")));
          return {
            version: retryVersion + 1,
            businessVersion,
            photos: [initialPhotos[1], initialPhotos[0]],
          };
        },
      });
      await act(async () => {
        typeName("First tab unsaved title");
        pickFiles([makeFile("replayed.png")]);
      });
      await act(async () => {
        button("Upload ready photos").click();
        await flushUpload();
      });
      await act(async () => {
        FakeXHR.sent[0].respond(200, {
          version: retryVersion,
          businessVersion,
          photos: initialPhotos,
        });
      });
      expect(
        document.querySelectorAll('img[alt="Local preview, not saved"]'),
      ).toHaveLength(1);
      await act(async () => {
        (
          document.querySelector(
            'button[aria-label="Move photo 2 earlier"]',
          ) as HTMLButtonElement
        ).click();
      });
      expect(photoRequests).toEqual([String(retryVersion)]);
      expect(fieldVersion()).toBe(expectedFormVersion);
      expect(
        (document.querySelector('input[name="name"]') as HTMLInputElement)
          .value,
      ).toBe("First tab unsaved title");
      await act(async () => {
        button("Save").click();
      });
      expect(saved).toEqual([
        {
          name: "First tab unsaved title",
          version: Number(expectedFormVersion),
        },
      ]);
      if (saveSucceeds) expect(document.body.textContent).toContain("Saved");
      else {
        expect(document.body.textContent).toContain("This product changed");
        expect(
          (document.querySelector('input[name="name"]') as HTMLInputElement)
            .value,
        ).toBe("First tab unsaved title");
      }
    },
  );
});
