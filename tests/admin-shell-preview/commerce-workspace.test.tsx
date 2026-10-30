// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommerceWorkspace } from "../../app/components/admin/commerce-workspace";
import type { WorkspaceView } from "../../app/lib/commerce/workspace";
import {
  commerceWorkspacePreviewRoutes,
  workspaceOrder,
  workspaceFixtureLoader,
} from "./commerce-workspace";

let root: Root;
let router: ReturnType<typeof createMemoryRouter>;
beforeEach(() => {
  document.body.innerHTML = '<div id="test-root" style="width:390px"></div>';
  root = createRoot(document.getElementById("test-root")!);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(async () => root.unmount());
  router?.dispose();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
async function mount(path = "/admin/commerce", view?: WorkspaceView) {
  router = createMemoryRouter(
    view
      ? [{ path: "*", element: <CommerceWorkspace view={view} /> }]
      : commerceWorkspacePreviewRoutes,
    { initialEntries: [path] },
  );
  await act(async () => root.render(<RouterProvider router={router} />));
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
function link(
  text: string,
  within: Pick<ParentNode, "querySelectorAll"> = document,
): HTMLAnchorElement {
  return [...within.querySelectorAll("a")].find(
    (item) => item.textContent?.trim() === text,
  )!;
}

describe("read-only commerce workspace presentation", () => {
  it("navigates overview to frozen order details with honest payment labels and Toronto times", async () => {
    await mount();
    expect(document.querySelectorAll("main")).toHaveLength(1);
    expect(document.body.textContent).toContain(
      "Presentation only — fictional fixtures",
    );
    expect(document.body.textContent).toContain(
      "Local test · fictional data · read only",
    );
    const nav = document.querySelector('nav[aria-label="Commerce workspace"]')!;
    expect(link("Overview", nav).getAttribute("aria-current")).toBe("page");
    await click(link(workspaceOrder.reference));
    expect(router.state.location.pathname).toBe(
      `/admin/commerce/orders/${workspaceOrder.reference}`,
    );
    expect(document.querySelector("h1")?.textContent).toBe("Order details");
    expect(
      link(
        "Orders",
        document.querySelector('nav[aria-label="Commerce workspace"]')!,
      ).getAttribute("aria-current"),
    ).toBe("page");
    expect(document.body.textContent).toContain("Payment preparation recorded");
    expect(document.body.textContent).toContain("This is not proof of payment");
    expect(document.body.textContent).toContain(
      "Ordinary cancellation or expiry cannot release this stock",
    );
    expect(document.body.textContent).toContain("ORBIT-GOLD");
    expect(document.body.textContent).toContain("Universal size");
    expect(document.body.textContent).toContain("2 × $25.00 CAD");
    expect(document.body.textContent).toContain("$99.00 CAD");
    expect(document.body.textContent).toContain("Canadian shipping");
    expect(document.querySelector("time")?.textContent).toContain("Toronto");
    expect(document.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-10-30T18:30:00.000Z",
    );
    expect(document.querySelectorAll("button")).toHaveLength(0);
  });
  it("submits labelled GET filters and preserves them through paging while resetting old cursors", async () => {
    await mount(
      `/admin/commerce/orders?status=prepared&reference=${workspaceOrder.reference}&after=old-cursor`,
    );
    const select = document.getElementById(
      "workspace-order-status",
    ) as unknown as HTMLSelectElement;
    const reference = document.getElementById(
      "workspace-reference",
    ) as HTMLInputElement;
    expect(select.value).toBe("prepared");
    expect(
      document.querySelector('label[for="workspace-reference"]')?.textContent,
    ).toContain("Full order reference");
    reference.focus();
    expect(document.activeElement).toBe(reference);
    select.value = "cancelled";
    reference.value = "";
    await click(
      document.querySelector('button[type="submit"]') as HTMLButtonElement,
    );
    let params = new URLSearchParams(router.state.location.search);
    expect(params.get("status")).toBe("cancelled");
    expect(params.has("after")).toBe(false);
    const next = link("Next page →");
    params = new URLSearchParams(new URL(next.href).search);
    expect(params.get("status")).toBe("cancelled");
    expect(params.get("after")).toBe("presentation-next-order-page");
    await click(next);
    expect(document.body.textContent).toContain("No orders to show");
    await click(link("First page"));
    expect(new URLSearchParams(router.state.location.search).has("after")).toBe(
      false,
    );
    await click(link("Clear filters"));
    expect(router.state.location.search).toBe("");
    expect(
      (
        document.getElementById(
          "workspace-order-status",
        ) as unknown as HTMLSelectElement
      ).value,
    ).toBe("all");
  });
  it("distinguishes inventory buckets and unpublished/disabled variants and preserves search during paging", async () => {
    await mount("/admin/commerce/inventory");
    expect(document.body.textContent).toContain("Physical stock");
    expect(document.body.textContent).toContain("Facebook reserved");
    expect(document.body.textContent).toContain("Checkout reserved");
    expect(document.body.textContent).toContain("Allocated to orders");
    expect(document.body.textContent).toContain("Website available");
    expect(document.body.textContent).toContain("Variant disabled");
    expect(document.body.textContent).toContain(
      "Product not published for sale",
    );
    (
      document.getElementById("workspace-stock-search") as HTMLInputElement
    ).value = "Silver-tone";
    (
      document.getElementById(
        "workspace-stock-status",
      ) as unknown as HTMLSelectElement
    ).value = "unavailable";
    await click(
      document.querySelector('button[type="submit"]') as HTMLButtonElement,
    );
    expect(document.body.textContent).toContain("ORBIT-SILVER");
    expect(document.body.textContent).not.toContain("ORBIT-GOLD");
    const params = new URLSearchParams(
      new URL(link("Next page →").href).search,
    );
    expect(params.get("search")).toBe("Silver-tone");
    expect(params.get("status")).toBe("unavailable");
    await click(link("Next page →"));
    expect(document.body.textContent).toContain("No inventory to show");
    expect(link("First page").href).not.toContain("after=");
  });
  it("renders empty overview, order and inventory scenes with navigation and no fake operational actions", async () => {
    await mount("/admin/commerce?scene=empty");
    for (const path of [
      "/admin/commerce?scene=empty",
      "/admin/commerce/orders?scene=empty",
      "/admin/commerce/inventory?scene=empty",
    ]) {
      await act(async () => router.navigate(path));
      expect(document.querySelector(".admin-empty")).not.toBeNull();
      expect(
        document.querySelector('nav[aria-label="Commerce workspace"]'),
      ).not.toBeNull();
      const buttons = [...document.querySelectorAll("button")].map(
        (button) => button.textContent,
      );
      expect(buttons.every((text) => text === "Apply filters")).toBe(true);
      expect(document.querySelectorAll('form[method="post"]')).toHaveLength(0);
    }
  });
  it("marks unrecognized stored states and missing item details for review instead of inferring payment", async () => {
    const view = workspaceFixtureLoader({
      request: new Request("http://127.0.0.1/admin/commerce/orders/example"),
      params: { orderId: workspaceOrder.reference },
    }) as Extract<WorkspaceView, { kind: "order" }>;
    await mount("/admin/commerce/orders/example", {
      ...view,
      order: { ...view.order, paymentState: "future-unrecognized" },
      lines: [],
    });
    expect(document.body.textContent).toContain(
      "Unrecognized status — needs review",
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Item details are unavailable",
    );
    expect(document.body.textContent).not.toContain("Payment received");
    expect(document.querySelectorAll("button")).toHaveLength(0);
  });
});
