// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OwnerNotifications } from "./owner-notifications";
import type { OwnerNotificationPage } from "../../lib/commerce/order-notification-http.server";
const instanceId = "11111111-1111-4111-8111-111111111111",
  orderId = "order-22222222-2222-4222-8222-222222222222",
  requestId = "33333333-3333-4333-8333-333333333333";
const input = {
    requestId,
    orderId,
    operation: "prepare",
    notificationId: null,
  },
  key = `commerce:notification:${instanceId}:${orderId}`;
const props: OwnerNotificationPage = {
  instanceId,
  canWrite: true,
  detail: { orderId, canPrepare: true, notifications: [] },
};
let root: Root;
const send = vi.fn<typeof fetch>();
beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.querySelector("#root")!);
  sessionStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", send);
  send.mockReset();
  vi.spyOn(crypto, "randomUUID").mockReturnValue(requestId);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const button = (name: string) =>
  [...document.querySelectorAll("button")].find((x) => x.textContent === name)!;
async function render(p = props) {
  const router = createMemoryRouter([
    { path: "/", element: <OwnerNotifications {...p} /> },
  ]);
  await act(async () => root.render(<RouterProvider router={router} />));
}
it("persists the original request before POST, blocks double clicks and requires canonical reload", async () => {
  send.mockImplementation(async () => {
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(input);
    return Response.json({
      state: "recorded",
      receipt: { ...input, testOnly: true, recorded: true },
    });
  });
  await render();
  await act(async () => {
    button("Prepare next test notification batch").click();
    button("Prepare next test notification batch").click();
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem(key)).toBeNull();
  expect(button("Prepare next test notification batch").disabled).toBe(true);
  expect(document.body.textContent).toContain("Reload this order");
});
it("uncertain result retains original UUID and lookup works with writes paused", async () => {
  sessionStorage.setItem(key, JSON.stringify(input));
  send.mockResolvedValue(Response.json({ state: "not_recorded" }));
  await render({ ...props, canWrite: false });
  expect(button("Prepare next test notification batch").disabled).toBe(true);
  expect(button("Retry original request").disabled).toBe(true);
  await act(async () => button("Check original receipt").click());
  expect(
    new URLSearchParams(String(send.mock.calls[0][1]?.body)).get("intent"),
  ).toBe("lookup");
  expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(input);
});
it("mismatched receipts never clear original recovery state", async () => {
  send.mockResolvedValue(
    Response.json({
      state: "recorded",
      receipt: {
        ...input,
        requestId: "44444444-4444-4444-8444-444444444444",
        testOnly: true,
        recorded: true,
      },
    }),
  );
  await render();
  await act(async () => button("Prepare next test notification batch").click());
  expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(input);
  expect(document.body.textContent).toContain("uncertain");
});
it("corrupt saved identity blocks actions without overwriting storage", async () => {
  sessionStorage.setItem(key, "broken");
  await render();
  expect(button("Prepare next test notification batch").disabled).toBe(true);
  expect(sessionStorage.getItem(key)).toBe("broken");
  expect(send).not.toHaveBeenCalled();
});
it("shows fictional inbox/history but never exposes a raw status bearer in DOM", async () => {
  const token = "a".repeat(64);
  await render({
    ...props,
    detail: {
      ...props.detail,
      notifications: [
        {
          id: requestId,
          kind: "capture_confirmed",
          recipient: "ontario@example.invalid",
          subject: "Test payment confirmed",
          body: "Fictional test only",
          state: "test_failed",
          statusUrl: `http://127.0.0.1:8801/checkout/status#${token}`,
          expiresAt: 1800000000000,
          canDeliver: true,
          canRevoke: true,
          attempts: [{ outcome: "test_failed", at: 1799999999999 }],
        },
      ],
    },
  });
  expect(document.body.textContent).toContain("ontario@example.invalid");
  expect(document.body.innerHTML).not.toContain(token);
  expect(document.body.textContent).toContain("no email is sent");
  expect(button("Simulate delivery").disabled).toBe(false);
});
