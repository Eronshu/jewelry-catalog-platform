// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PreviewForm, previewFormRoute } from "./preview-form";

let root: Root;

beforeEach(() => {
  document.body.innerHTML = '<div id="test-root"></div>';
  root = createRoot(document.getElementById("test-root")!);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.confirm = vi.fn().mockReturnValue(false);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("standalone admin form preview", () => {
  for (const [path, error] of [
    ["/form", false],
    ["/error", true],
  ] as const) {
    it(`keeps ${path} visible and explains that Save does not persist`, async () => {
      const router = createMemoryRouter(
        [previewFormRoute(path, <PreviewForm error={error} />)],
        { initialEntries: [path] },
      );
      await act(async () => root.render(<RouterProvider router={router} />));
      await act(async () => {
        (
          document.querySelector('button[value="create"]') as HTMLButtonElement
        ).click();
      });
      expect(router.state.location.pathname).toBe(path);
      expect(document.querySelector("form.admin-product-form")).not.toBeNull();
      expect(document.querySelector('[role="status"]')?.textContent).toBe(
        "This is a visual preview. No product was saved.",
      );
      expect(document.body.textContent).not.toContain("405 Method Not Allowed");
      if (error)
        expect(document.querySelector('[role="alert"]')?.textContent).toContain(
          "Please correct the highlighted fields.",
        );
    });
  }
});
