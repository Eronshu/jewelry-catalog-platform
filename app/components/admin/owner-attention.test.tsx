// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OwnerAttention } from "./owner-attention";
import type { AttentionPage } from "../../lib/commerce/owner-attention-http.server";
const orderId = "order-22222222-2222-4222-8222-222222222222";
const page: AttentionPage = {
  canOpenRefunds: true,
  canOpenNotifications: true,
  view: {
    observedAt: 1800000000000,
    filter: "all",
    reference: "",
    nextCursor: "opaque-cursor",
    summary: {
      orderCount: 1,
      paymentCount: 1,
      refundCount: 1,
      notificationCount: 1,
    },
    items: [
      {
        orderId,
        createdAt: 1799999900000,
        totalCents: 4400,
        paymentState: "processing",
        fulfillment: "none",
        paymentReview: true,
        refundReview: true,
        notificationPending: 1,
        notificationFailed: 2,
        notificationMissing: 3,
        notificationExhausted: 1,
      },
    ],
  },
};
let root: Root;
beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.querySelector("#root")!);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
async function render(props = page) {
  const router = createMemoryRouter(
    [
      {
        path: "/admin/commerce/attention",
        element: <OwnerAttention {...props} />,
      },
    ],
    { initialEntries: ["/admin/commerce/attention"] },
  );
  await act(async () => root.render(<RouterProvider router={router} />));
  return router;
}
it("shows recorded reasons and guarded deep links without mutation controls or contact fields", async () => {
  await render();
  expect(document.body.textContent).toContain("Payment needs review");
  expect(document.body.textContent).toContain("not proof of a failed charge");
  expect(document.body.textContent).toContain("not fresh verification");
  expect(document.body.textContent).toContain("no actual email");
  expect(
    document.querySelector(
      `a[href="/admin/commerce/orders/${orderId}/refund"]`,
    ),
  ).not.toBeNull();
  expect(
    document.querySelector(
      `a[href="/admin/commerce/orders/${orderId}/notifications"]`,
    ),
  ).not.toBeNull();
  expect(
    [...document.querySelectorAll("button")].map((x) => x.textContent),
  ).toEqual(["Apply filters"]);
  expect(
    document.querySelectorAll(
      'input[name="email"],input[name="token"],input[type="hidden"]',
    ),
  ).toHaveLength(0);
});
it("hides refund/notification deep links when those independent screens are unavailable", async () => {
  await render({ ...page, canOpenRefunds: false, canOpenNotifications: false });
  expect(document.querySelector('a[href$="/refund"]')).toBeNull();
  expect(document.querySelector('a[href$="/notifications"]')).toBeNull();
  expect(document.body.textContent).toContain("Refund needs review");
});
it("filter navigation drops old cursors while pagination preserves category and exact reference", async () => {
  const props = {
    ...page,
    view: { ...page.view, filter: "refund" as const, reference: orderId },
  };
  await render(props);
  const next = [...document.querySelectorAll("a")].find(
    (a) => a.textContent === "Next page of recorded issues",
  )!;
  const nextUrl = new URL(next.getAttribute("href")!, "http://localhost");
  expect(nextUrl.searchParams.get("after")).toBe("opaque-cursor");
  expect(nextUrl.searchParams.get("status")).toBe("refund");
  expect(nextUrl.searchParams.get("reference")).toBe(orderId);
  const payment = [...document.querySelectorAll("a")].find((a) =>
    a.textContent?.includes("Need payment review"),
  )!;
  expect(payment.getAttribute("href")).toContain("status=payment");
  expect(payment.getAttribute("href")).not.toContain("after=");
});
it("empty views never claim a reconciled or safe-to-fulfill order", async () => {
  await render({
    ...page,
    view: {
      ...page.view,
      items: [],
      nextCursor: null,
      summary: {
        orderCount: 0,
        paymentCount: 0,
        refundCount: 0,
        notificationCount: 0,
      },
    },
  });
  expect(document.body.textContent).toContain(
    "No recorded issues in this view",
  );
  expect(document.body.textContent).toContain("does not guarantee");
  expect(document.body.textContent).toContain(
    "does not confirm current provider status",
  );
  expect(document.body.textContent).not.toContain("All payments verified");
});
