// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import StatusPage from "./checkout-status";
vi.mock("../lib/commerce/order-notification-http.server", () => ({
  notificationHeaders: {},
  loadNotificationStatusLanding: vi.fn(),
}));
let root: Root;
const token = "a".repeat(64),
  send = vi.fn<typeof fetch>();
beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  history.replaceState(null, "", `/checkout/status#${token}`);
  root = createRoot(document.querySelector("#root")!);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", send);
  send.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
it("removes fragment before explicit read; never auto-sends, exposes or stores the token", async () => {
  await act(async () => root.render(<StatusPage />));
  expect(location.hash).toBe("");
  expect(send).not.toHaveBeenCalled();
  expect(document.body.innerHTML).not.toContain(token);
  send.mockResolvedValue(
    Response.json({
      testOnly: true,
      status: {
        orderId: "order-22222222-2222-4222-8222-222222222222",
        state: "confirmed",
        paymentState: "succeeded",
        fulfillment: "ready_to_pack",
        delivery: "shipping",
        totalCents: 4400,
        refundedCents: 1500,
      },
    }),
  );
  await act(async () =>
    (document.querySelector("button") as HTMLButtonElement).click(),
  );
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0]).toBe("/checkout/status/read");
  expect(String(send.mock.calls[0][1]?.body)).toBe(`token=${token}`);
  expect(document.body.textContent).toContain("15.00");
  expect(document.querySelectorAll("input,form")).toHaveLength(0);
});
it("expired or invalid status never leaves stale order details visible", async () => {
  send.mockResolvedValue(
    Response.json({ error: "not found" }, { status: 404 }),
  );
  await act(async () => root.render(<StatusPage />));
  await act(async () =>
    (document.querySelector("button") as HTMLButtonElement).click(),
  );
  expect(document.body.textContent).toContain(
    "unavailable, expired or revoked",
  );
  expect(document.body.innerHTML).not.toContain(token);
  expect(document.body.textContent).not.toContain("Current test order status");
});

it("accepts a new same-page fragment and ignores a late response for the previous bearer", async () => {
  let resolveOld!: (r: Response) => void;
  send.mockImplementationOnce(
    () =>
      new Promise<Response>((r) => {
        resolveOld = r;
      }),
  );
  await act(async () => root.render(<StatusPage />));
  await act(async () =>
    (document.querySelector("button") as HTMLButtonElement).click(),
  );
  const next = "b".repeat(64);
  await act(async () => {
    history.replaceState(null, "", `/checkout/status#${next}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  expect(location.hash).toBe("");
  expect(document.body.innerHTML).not.toContain(next);
  expect((document.querySelector("button") as HTMLButtonElement).disabled).toBe(
    false,
  );
  send.mockResolvedValueOnce(
    Response.json({ error: "invalid" }, { status: 404 }),
  );
  await act(async () =>
    (document.querySelector("button") as HTMLButtonElement).click(),
  );
  expect(String(send.mock.calls[1][1]?.body)).toBe(`token=${next}`);
  await act(async () =>
    resolveOld(
      Response.json({
        testOnly: true,
        status: {
          orderId: "order-22222222-2222-4222-8222-222222222222",
          state: "confirmed",
          paymentState: "succeeded",
          fulfillment: "completed",
          delivery: "shipping",
          totalCents: 4400,
          refundedCents: 0,
        },
      }),
    ),
  );
  expect(document.body.textContent).not.toContain("Current test order status");
  expect(document.body.textContent).toContain(
    "unavailable, expired or revoked",
  );
});
