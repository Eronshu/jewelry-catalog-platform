// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryRouter,
  RouterProvider,
  useActionData,
  useLoaderData,
} from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NewProduct from "./admin-product-new";

const category = {
  id: 4,
  name: "Rings",
  slug: "rings",
  sortOrder: 0,
  isActive: true,
};
const draft = { id: 17, status: "draft", version: 100, businessVersion: 100 };
const photo = { id: 51, altText: "", sortOrder: 0, width: 64, height: 64 };
let root: Root;

class FakeXHR {
  static sent: FakeXHR[] = [];
  headers = new Map<string, string>();
  upload: { onprogress?: (event: ProgressEvent) => void } = {};
  onload?: () => void;
  status = 0;
  responseText = "";
  body?: File;
  url = "";
  open(_method: string, url: string) {
    this.url = url;
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
function Page() {
  return (
    <NewProduct
      {...({
        loaderData: useLoaderData(),
        actionData: useActionData(),
      } as Parameters<typeof NewProduct>[0])}
    />
  );
}
function file(name: string, type = "image/png") {
  const value = new File(["fixture"], name, { type });
  Object.defineProperty(value, "arrayBuffer", {
    value: async () => new TextEncoder().encode("fixture").buffer,
  });
  return value;
}
function pick(...files: File[]) {
  const input = document.querySelector("#photo-picker") as HTMLInputElement;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}
function typeName(value: string) {
  const input = document.querySelector(
    'input[name="name"]',
  ) as HTMLInputElement;
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}
function button(label: string) {
  const found = Array.from(document.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === label,
  );
  expect(found, `button ${label}`).toBeTruthy();
  return found as HTMLButtonElement;
}
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
async function waitForSent(count: number) {
  for (let attempt = 0; attempt < 20 && FakeXHR.sent.length < count; attempt++)
    await act(async () => flush());
  expect(FakeXHR.sent).toHaveLength(count);
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
async function scenario(
  fetchMock: ReturnType<typeof vi.fn> = vi.fn(async () =>
    json({ product: draft }),
  ),
) {
  vi.stubGlobal("fetch", fetchMock);
  const router = createMemoryRouter(
    [
      {
        path: "/admin/products/new",
        loader: () => ({
          categories: [category],
          requestKey: crypto.randomUUID(),
        }),
        element: <Page />,
      },
      { path: "/admin/products/:id/edit", element: <p>Saved edit view</p> },
      { path: "/admin/products", element: <p>Products list</p> },
    ],
    { initialEntries: ["/admin/products/new"] },
  );
  await act(async () => root.render(<RouterProvider router={router} />));
  return { router, fetchMock };
}

beforeEach(() => {
  document.body.innerHTML = '<div id="test-root"></div>';
  sessionStorage.clear();
  root = createRoot(document.getElementById("test-root")!);
  FakeXHR.sent = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
  let index = 0;
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: () => `blob:preview-${++index}`,
      revokeObjectURL: vi.fn(),
    }),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  sessionStorage.clear();
});

describe("one-Save Add product owner flow", () => {
  it("uploads in the visual order after a selected-photo pointer drag and one Save", async () => {
    await scenario();
    await act(async () => pick(file("front.png"), file("detail.png")));
    const handle = document.querySelector(
      'button[aria-label="Drag detail.png to reorder"]',
    ) as HTMLButtonElement;
    handle.setPointerCapture = vi.fn();
    vi.spyOn(document, "elementFromPoint").mockReturnValue(
      document.querySelector("[data-pending-id]"),
    );
    await act(async () => {
      for (const type of ["pointerdown", "pointermove", "pointerup"])
        handle.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerId: 5,
            pointerType: "touch",
          }),
        );
    });
    expect(
      Array.from(document.querySelectorAll("[data-pending-id] strong")).map(
        (item) => item.textContent,
      ),
    ).toEqual(["detail.png", "front.png"]);
    await act(async () => {
      button("Save").click();
      await flush();
    });
    await waitForSent(1);
    expect(FakeXHR.sent[0].body?.name).toBe("detail.png");
    await act(async () =>
      FakeXHR.sent[0].respond(200, {
        version: 101,
        businessVersion: 100,
        photos: [photo],
      }),
    );
    await waitForSent(2);
    expect(FakeXHR.sent[1].body?.name).toBe("front.png");
    expect(FakeXHR.sent[1].headers.get("X-Product-Version")).toBe("101");
  });

  it("uploads selected photos in the order set by Move earlier", async () => {
    await scenario();
    await act(async () => pick(file("front.png"), file("detail.png")));
    const move = document.querySelector(
      'button[aria-label="Move selected photo 2 earlier"]',
    ) as HTMLButtonElement;
    expect(move.disabled).toBe(false);
    await act(async () => move.click());
    expect(
      Array.from(document.querySelectorAll("[data-pending-id] strong")).map(
        (item) => item.textContent,
      ),
    ).toEqual(["detail.png", "front.png"]);
    await act(async () => {
      button("Save").click();
      await flush();
    });
    await waitForSent(1);
    expect(FakeXHR.sent[0].body?.name).toBe("detail.png");
  });

  it("ignores a double-click and opens Edit after creating a Draft with no selected photos", async () => {
    let resolve!: (value: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const { router } = await scenario(fetchMock);
    await act(async () => {
      button("Save").click();
      button("Save").click();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("Saving your Draft");
    await act(async () => resolve(json({ product: draft })));
    expect(router.state.location.pathname).toBe("/admin/products/17/edit");
    expect(FakeXHR.sent).toHaveLength(0);
  });

  it("keeps local files and request key through revalidation, creates once, then uploads sequentially with progress", async () => {
    const { router, fetchMock } = await scenario();
    await act(async () => {
      typeName("Owner ring");
      pick(file("one.png"), file("two.png"));
    });
    expect(
      document.querySelectorAll('img[alt="Local preview, not saved"]'),
    ).toHaveLength(2);
    expect(
      document.querySelector("form.admin-product-form #photo-picker"),
    ).toBeTruthy();
    const key = (
      document.querySelector('input[name="requestKey"]') as HTMLInputElement
    ).value;
    await act(async () => router.revalidate());
    expect(
      (document.querySelector('input[name="requestKey"]') as HTMLInputElement)
        .value,
    ).toBe(key);
    expect(
      document.querySelectorAll('img[alt="Local preview, not saved"]'),
    ).toHaveLength(2);
    await act(async () => {
      button("Save").click();
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const submitted = fetchMock.mock.calls[0][1].body as URLSearchParams;
    expect(submitted.get("name")).toBe("Owner ring");
    expect(submitted.get("requestKey")).toBe(key);
    await waitForSent(1);
    expect(FakeXHR.sent[0].url).toBe("/admin/products/17/photos/upload");
    await act(async () => router.revalidate());
    expect(
      (document.querySelector('input[name="requestKey"]') as HTMLInputElement)
        .value,
    ).toBe(key);
    expect(
      document.querySelectorAll('img[alt="Local preview, not saved"]'),
    ).toHaveLength(2);
    expect(FakeXHR.sent).toHaveLength(1);
    expect(
      (document.querySelector('input[name="name"]') as HTMLInputElement)
        .disabled,
    ).toBe(true);
    await act(async () => FakeXHR.sent[0].progress(3, 6));
    expect(document.body.textContent).toContain("Uploading 50%");
    await act(async () =>
      FakeXHR.sent[0].respond(200, {
        version: 101,
        businessVersion: 100,
        photos: [photo],
      }),
    );
    await waitForSent(2);
    expect(FakeXHR.sent[1].headers.get("X-Product-Version")).toBe("101");
    await act(async () =>
      FakeXHR.sent[1].respond(200, {
        version: 102,
        businessVersion: 100,
        photos: [photo, { ...photo, id: 52, sortOrder: 1 }],
      }),
    );
    await act(async () => flush());
    expect(router.state.location.pathname).toBe("/admin/products/17/edit");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not start the next selected photo after the owner confirms leaving", async () => {
    const { router } = await scenario();
    await act(async () => pick(file("in-flight.png"), file("not-started.png")));
    await act(async () => {
      button("Save").click();
      await flush();
    });
    await waitForSent(1);
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    await act(async () => {
      (
        document.querySelector(
          'a[href="/admin/products/17/edit"]',
        ) as HTMLAnchorElement
      ).click();
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(router.state.location.pathname).toBe("/admin/products/17/edit");
    await act(async () => {
      FakeXHR.sent[0].respond(200, {
        version: 101,
        businessVersion: 100,
        photos: [photo],
      });
      await flush();
    });
    expect(FakeXHR.sent).toHaveLength(1);
  });

  it("keeps details and selections after validation, and lets invalid files be replaced or removed before Save", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json(
          {
            error: "Choose an active category.",
            fieldErrors: { categoryId: "Choose an active category." },
          },
          400,
        ),
      )
      .mockResolvedValueOnce(json({ product: draft }));
    await scenario(fetchMock);
    await act(async () => {
      typeName("Owner ring");
      pick(file("bad.heic", "image/heic"), file("valid.png"));
    });
    expect(document.body.textContent).toContain(
      "HEIC and HEIF are not supported",
    );
    await act(async () => button("Save").click());
    expect(document.body.textContent).toContain("Choose an active category");
    expect(
      (document.querySelector('input[name="name"]') as HTMLInputElement).value,
    ).toBe("Owner ring");
    expect(
      document.querySelectorAll('img[alt="Local preview, not saved"]'),
    ).toHaveLength(2);
    await act(async () => button("Remove selection").click());
    expect(
      document.querySelectorAll('img[alt="Local preview, not saved"]'),
    ).toHaveLength(1);
    await act(async () => {
      button("Save").click();
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await waitForSent(1);
    expect(FakeXHR.sent[0].body?.name).toBe("valid.png");
  });

  it("replaces an invalid selection with a fresh upload identity and never sends the invalid file", async () => {
    await scenario();
    await act(async () => pick(file("unsupported.heic", "image/heic")));
    const replacement = document.querySelector(
      'input[aria-label="Replacement for unsupported.heic"]',
    ) as HTMLInputElement;
    expect(replacement).toBeTruthy();
    await act(async () => {
      Object.defineProperty(replacement, "files", {
        configurable: true,
        value: [file("replacement.png")],
      });
      replacement.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(document.body.textContent).not.toContain("unsupported.heic");
    await act(async () => {
      button("Save").click();
      await flush();
    });
    await waitForSent(1);
    expect(FakeXHR.sent[0].body?.name).toBe("replacement.png");
    expect(FakeXHR.sent[0].headers.get("X-Upload-Id")).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it("rejects a replacement that would exceed the 100 MB selection limit", async () => {
    await scenario();
    const sized = (name: string, size: number) => {
      const selected = file(name);
      Object.defineProperty(selected, "size", { value: size });
      return selected;
    };
    await act(async () => {
      pick(
        ...Array.from({ length: 6 }, (_, index) =>
          sized(`selected-${index}.png`, 16_500_000),
        ),
      );
    });
    const replacement = document.querySelector(
      'input[aria-label="Replacement for selected-0.png"]',
    ) as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(replacement, "files", {
        configurable: true,
        value: [sized("too-large-total.png", 18_000_000)],
      });
      replacement.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(document.body.textContent).toContain(
      "Choose up to 10 photos and 100 MB at a time.",
    );
    expect(document.body.textContent).toContain("selected-0.png");
    expect(document.body.textContent).not.toContain("too-large-total.png");
    expect(
      document.querySelectorAll('img[alt="Local preview, not saved"]'),
    ).toHaveLength(6);
  });

  it("retries an uncertain create with its exact payload and creates no second Draft request key", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValueOnce(json({ product: draft }));
    await scenario(fetchMock);
    await act(async () => {
      typeName("Submitted title");
      pick(file("pending.png"));
      button("Save").click();
      await flush();
    });
    expect(document.body.textContent).toContain("Could not confirm the Draft");
    expect(
      (document.querySelector('input[name="name"]') as HTMLInputElement)
        .disabled,
    ).toBe(true);
    await act(async () => {
      button("Retry saving Draft").click();
      await flush();
    });
    await waitForSent(1);
    const first = fetchMock.mock.calls[0][1].body as URLSearchParams;
    const second = fetchMock.mock.calls[1][1].body as URLSearchParams;
    expect(second.toString()).toBe(first.toString());
    expect(FakeXHR.sent[0].body?.name).toBe("pending.png");
  });

  it("warns once for Back during an upload and preserves the queue when leaving is cancelled", async () => {
    const { router } = await scenario();
    await act(async () => {
      pick(file("active.png"));
      button("Save").click();
      await flush();
    });
    await waitForSent(1);
    const confirm = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    vi.stubGlobal("confirm", confirm);
    await act(async () => router.navigate("/admin/products"));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(router.state.location.pathname).toBe("/admin/products/new");
    expect(document.body.textContent).toContain("Uploading 0%");
    await act(async () => router.navigate("/admin/products"));
    expect(router.state.location.pathname).toBe("/admin/products");
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("retains the Draft and successful photo after partial failure, then retries only the failed file", async () => {
    const { router, fetchMock } = await scenario();
    await act(async () => {
      pick(file("first.png"), file("second.png"));
      button("Save").click();
      await flush();
    });
    await waitForSent(1);
    await act(async () =>
      FakeXHR.sent[0].respond(200, {
        version: 101,
        businessVersion: 100,
        photos: [photo],
      }),
    );
    await waitForSent(2);
    const failedId = FakeXHR.sent[1].headers.get("X-Upload-Id");
    await act(async () =>
      FakeXHR.sent[1].respond(503, {
        error: "Upload failed. Retry this photo.",
      }),
    );
    expect(router.state.location.pathname).toBe("/admin/products/new");
    expect(document.body.textContent).toContain(
      "Draft saved — photos need attention",
    );
    expect(
      document.querySelector('a[href="/admin/products/17/edit"]'),
    ).toBeTruthy();
    await act(async () => {
      button("Retry").click();
      await flush();
    });
    await waitForSent(3);
    expect(FakeXHR.sent[2].body?.name).toBe("second.png");
    expect(FakeXHR.sent[2].headers.get("X-Upload-Id")).toBe(failedId);
    await act(async () =>
      FakeXHR.sent[2].respond(200, {
        version: 102,
        businessVersion: 100,
        photos: [photo, { ...photo, id: 52, sortOrder: 1 }],
      }),
    );
    await act(async () => flush());
    expect(router.state.location.pathname).toBe("/admin/products/17/edit");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("warns on navigation during creation and keeps the pending request and queue on Cancel", async () => {
    let resolve!: (value: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const { router } = await scenario(fetchMock);
    await act(async () => {
      typeName("Unsaved title");
      pick(file("pending.png"));
      button("Save").click();
    });
    const confirm = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    vi.stubGlobal("confirm", confirm);
    await act(async () => router.navigate("/admin/products"));
    expect(router.state.location.pathname).toBe("/admin/products/new");
    expect(document.body.textContent).toContain("Saving your Draft");
    expect(
      document.querySelectorAll('img[alt="Local preview, not saved"]'),
    ).toHaveLength(1);
    await act(async () => router.navigate("/admin/products"));
    expect(router.state.location.pathname).toBe("/admin/products");
    expect(confirm).toHaveBeenCalledTimes(2);
    await act(async () => resolve(json({ product: draft })));
    expect(router.state.location.pathname).toBe("/admin/products");
  });

  it("recovers a confirmed Draft after reload without claiming to restore selected files", async () => {
    sessionStorage.setItem(
      "admin-product-create-pending",
      JSON.stringify({ requestKey: crypto.randomUUID(), id: 17 }),
    );
    const fetchMock = vi.fn(async () => json({ product: draft }));
    const { router } = await scenario(fetchMock);
    expect(router.state.location.pathname).toBe("/admin/products/17/edit");
    const calls = fetchMock.mock.calls as unknown as Array<
      [string, { body: URLSearchParams }]
    >;
    expect(calls[0][1].body.get("intent")).toBe("lookup");
    expect(FakeXHR.sent).toHaveLength(0);
  });

  it("leaves an uncertain reload for explicit Products inspection, without an automatic create retry", async () => {
    sessionStorage.setItem(
      "admin-product-create-pending",
      JSON.stringify({ requestKey: crypto.randomUUID() }),
    );
    const fetchMock = vi.fn(async () => json({ product: null }));
    await scenario(fetchMock);
    expect(document.body.textContent).toContain(
      "Check Products before starting another one",
    );
    expect(document.body.textContent).toContain(
      "Selected photos cannot be restored",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
