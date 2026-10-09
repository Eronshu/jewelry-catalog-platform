// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { AdminShell } from "./admin-shell";

let root: Root;

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

it("keeps Admin visible while the first website navigation loads", async () => {
  let finishHomeLoad!: () => void;
  const homeLoad = new Promise<void>((resolve) => {
    finishHomeLoad = resolve;
  });
  const router = createMemoryRouter(
    [
      {
        path: "/admin",
        element: <AdminShell>Admin content</AdminShell>,
      },
      {
        path: "/",
        loader: () => homeLoad,
        element: <p>Website home</p>,
      },
    ],
    { initialEntries: ["/admin"] },
  );

  await act(async () => root.render(<RouterProvider router={router} />));
  await act(async () => {
    (document.querySelector(".admin-back-link") as HTMLAnchorElement).click();
  });

  expect(router.state.navigation.location?.pathname).toBe("/");
  expect(document.body.textContent).toContain("Admin content");
  expect(document.body.textContent).toContain("Opening website…");

  await act(async () => finishHomeLoad());
  expect(document.body.textContent).toContain("Website home");
  expect(document.body.textContent).not.toContain("Admin content");
});
