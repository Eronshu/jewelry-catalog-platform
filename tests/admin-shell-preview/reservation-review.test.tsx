// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AdminWelcome } from "../../app/components/admin/admin-shell";
import { reservationReviewPath } from "../../app/components/admin/reservation-review";
import {
  fixtureDetail,
  fixtureList,
  fixtureReference,
  ReservationPreview,
  reservationPreviewRoute,
} from "./reservations";
import type { ReservationReviewView } from "../../app/lib/commerce/reservation-review-request.server";

let root: Root;
beforeEach(() => {
  sessionStorage.clear();
  document.body.innerHTML = '<div id="test-root"></div>';
  root = createRoot(document.getElementById("test-root")!);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
async function open(
  path = reservationReviewPath,
  loader = reservationPreviewRoute.loader,
) {
  const router = createMemoryRouter([{ ...reservationPreviewRoute, loader }], {
    initialEntries: [path],
  });
  await act(async () => {
    root.render(<RouterProvider router={router} />);
  });
  return router;
}
function anchor(text: string) {
  return Array.from(document.querySelectorAll("a")).find(
    (item) => item.textContent === text,
  )!;
}
function button(text: string) {
  return Array.from(document.querySelectorAll("button")).find(
    (item) => item.textContent === text,
  )!;
}

it("explains attention, responsibilities, read-only and payment limits without action buttons", async () => {
  await open();
  const content = document.querySelector("main")!.textContent!;
  for (const text of [
    "Fictional orders only",
    "No real payment",
    "Developer: inspect the expiry run",
    "Developer: reconcile payment facts",
    "Owner: check the goods",
    "Unknown — needs reconciliation",
    "Not started",
    "not a complete order or payment report",
  ])
    expect(content).toContain(text);
  expect(
    Array.from(document.querySelectorAll("button")).map(
      (item) => item.textContent,
    ),
  ).toEqual(["Refresh results", "Find order"]);
  expect(document.querySelector("form")?.method).toBe("get");
  expect(document.activeElement).toBe(document.querySelector("h1"));
  expect(document.querySelector("a.skip-link")?.getAttribute("href")).toBe(
    "#main",
  );
});
it("uses the server cursor for bounded next-page navigation and can restart the list", async () => {
  const router = await open();
  const next = anchor("Next page (up to 25 reservations)");
  expect(JSON.parse(new URL(next.href).searchParams.get("after")!)).toEqual(
    fixtureList.result.nextCursor,
  );
  await act(async () => next.click());
  expect(router.state.location.search).toContain("after=");
  expect(document.querySelector("main")?.textContent).toContain(
    "No reservations on this page",
  );
  expect(anchor("Next page (up to 25 reservations)")).toBeUndefined();
  await act(async () => anchor("First page").click());
  expect(document.querySelectorAll(".reservation-list > li")).toHaveLength(2);
});
it("finds an exact reference using GET and shows minimal detail with bounded history", async () => {
  const router = await open();
  const input = document.querySelector<HTMLInputElement>(
    'input[name="reference"]',
  )!;
  expect(input.labels?.[0].textContent).toContain("full reference");
  expect(input.autocomplete).toBe("off");
  expect(input.required).toBe(true);
  input.value = fixtureReference;
  await act(async () => button("Find order").click());
  expect(
    new URLSearchParams(router.state.location.search).get("reference"),
  ).toBe(fixtureReference);
  const main = document.querySelector("main")!;
  for (const text of [
    "Cancelled",
    "fictional-necklace-gold",
    "Quantity: 2",
    "Reservation cancelled",
    "Only the latest 25 changes",
    "Record version: 2",
  ])
    expect(main.textContent).toContain(text);
  expect(document.activeElement).toBe(document.querySelector("h1"));
});
it("refreshes the current detail, marks pending data, then replaces it without a write", async () => {
  let finish!: (view: ReservationReviewView) => void;
  const loader = vi
    .fn()
    .mockReturnValueOnce(fixtureDetail)
    .mockImplementationOnce(
      () =>
        new Promise<ReservationReviewView>((resolve) => {
          finish = resolve;
        }),
    );
  const router = createMemoryRouter(
    [{ path: reservationReviewPath, loader, element: <ReservationPreview /> }],
    {
      initialEntries: [
        `${reservationReviewPath}?reference=${fixtureReference}`,
      ],
    },
  );
  await act(async () => root.render(<RouterProvider router={router} />));
  await act(async () => button("Refresh results").click());
  expect(button("Refresh results").disabled).toBe(true);
  expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(document.querySelector('[role="status"]')?.textContent).toContain(
    "previous result",
  );
  await act(async () =>
    finish({
      ...fixtureDetail,
      result: {
        ...fixtureDetail.result,
        order: { ...fixtureDetail.result.order, version: 3 },
      },
    }),
  );
  expect(document.querySelector("main")?.textContent).toContain(
    "Record version: 3",
  );
  expect(router.state.location.search).toContain(fixtureReference);
  expect(loader.mock.calls[1][0].request.method).toBe("GET");
  expect(button("Refresh results").disabled).toBe(false);
});
it("replaces a previously successful result with a generic outage, then allows retry", async () => {
  const outage = {
    kind: "error",
    status: 503,
    message: "private error must not appear",
  } as const;
  const loader = vi
    .fn()
    .mockReturnValueOnce(fixtureList)
    .mockReturnValueOnce(outage)
    .mockReturnValue(fixtureList);
  const router = createMemoryRouter(
    [{ path: reservationReviewPath, loader, element: <ReservationPreview /> }],
    { initialEntries: [reservationReviewPath] },
  );
  await act(async () => root.render(<RouterProvider router={router} />));
  await act(async () => button("Refresh results").click());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "temporarily unavailable",
  );
  expect(document.querySelector(".reservation-list")).toBeNull();
  expect(document.body.textContent).not.toContain("private error");
  await act(async () => button("Refresh results").click());
  expect(document.querySelectorAll(".reservation-list > li")).toHaveLength(2);
});
it.each([400, 404, 405] as const)(
  "explains a %s result without echoing submitted values",
  async (status) => {
    await open(reservationReviewPath, () => ({
      kind: "error",
      status,
      message: "do not echo customer@example.invalid",
    }));
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain("customer@example.invalid");
    expect(anchor("Return to the first page")).toBeDefined();
  },
);
it("hides the local-only Admin entry unless the local availability flag is set", async () => {
  const router = createMemoryRouter(
    [
      { path: "/admin", element: <AdminWelcome /> },
      { path: "/local", element: <AdminWelcome localReservations /> },
    ],
    { initialEntries: ["/admin"] },
  );
  await act(async () => root.render(<RouterProvider router={router} />));
  expect(anchor("Review test reservations")).toBeUndefined();
  await act(async () => router.navigate("/local"));
  expect(anchor("Review test reservations")?.getAttribute("href")).toBe(
    reservationReviewPath,
  );
});
it("offers confirmation only in exact eligible detail, and separates operator recovery from ordinary expiry", async () => {
  const router = await open(`${reservationReviewPath}?scene=eligible`);
  expect(document.querySelector("#recovery-confirmation")).not.toBeNull();
  expect(button("Confirm cancellation and release").disabled).toBe(true);
  await act(async () =>
    router.navigate(`${reservationReviewPath}?scene=recovered`),
  );
  expect(document.querySelector("#recovery-confirmation")).toBeNull();
  expect(document.body.textContent).toContain(
    "Operator confirmed expired unpaid reservation",
  );
  expect(document.body.textContent).toContain("1 → 2");
});
