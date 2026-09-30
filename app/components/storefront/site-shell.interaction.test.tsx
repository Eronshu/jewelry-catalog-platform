// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SiteShell } from "./site-shell";

let root: Root;
let mediaListeners: Set<(event: MediaQueryListEvent) => void>;

function menuButton() {
  return document.querySelector(
    'button[aria-controls="mobile-navigation"]',
  ) as HTMLButtonElement;
}

function mobileNavigation() {
  return document.querySelector(
    'nav[aria-label="Mobile primary"]',
  ) as HTMLElement;
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function renderShell() {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/"]}>
        <SiteShell>
          <Routes>
            <Route path="/" element={<h1>Home content</h1>} />
            <Route path="/shop" element={<h1>Shop content</h1>} />
          </Routes>
        </SiteShell>
      </MemoryRouter>,
    );
  });
}

beforeEach(() => {
  document.body.innerHTML =
    '<button id="outside">Outside</button><div id="test-root"></div>';
  root = createRoot(document.getElementById("test-root")!);
  mediaListeners = new Set();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: (
      _type: string,
      listener: (event: MediaQueryListEvent) => void,
    ) => mediaListeners.add(listener),
    removeEventListener: (
      _type: string,
      listener: (event: MediaQueryListEvent) => void,
    ) => mediaListeners.delete(listener),
  }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("storefront navigation interactions", () => {
  it("keeps existing focus on initial render and a same-route wordmark click", async () => {
    const outside = document.getElementById("outside")!;
    outside.focus();

    await renderShell();
    expect(document.activeElement).toBe(outside);

    await click(document.querySelector(".wordmark")!);
    expect(document.activeElement).toBe(outside);
  });

  it("opens and closes the mobile menu with its trigger", async () => {
    await renderShell();

    expect(menuButton().getAttribute("aria-expanded")).toBe("false");
    expect(mobileNavigation().hidden).toBe(true);

    await click(menuButton());
    expect(menuButton().getAttribute("aria-expanded")).toBe("true");
    expect(mobileNavigation().hidden).toBe(false);

    await click(menuButton());
    expect(menuButton().getAttribute("aria-expanded")).toBe("false");
    expect(mobileNavigation().hidden).toBe(true);
  });

  it("closes on Escape and returns focus to the menu trigger", async () => {
    await renderShell();
    await click(menuButton());
    const shopLink = mobileNavigation().querySelector('a[href="/shop"]')!;
    (shopLink as HTMLAnchorElement).focus();

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });

    expect(mobileNavigation().hidden).toBe(true);
    expect(document.activeElement).toBe(menuButton());
  });

  it("closes the mobile menu after its navigation link is used", async () => {
    await renderShell();
    await click(menuButton());

    await click(mobileNavigation().querySelector('a[href="/shop"]')!);

    expect(mobileNavigation().hidden).toBe(true);
    expect(menuButton().getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("main h1")?.textContent).toBe("Shop content");
  });

  it("returns focus to the trigger after same-route mobile navigation", async () => {
    await renderShell();
    await click(menuButton());
    await click(mobileNavigation().querySelector('a[href="/shop"]')!);
    await click(menuButton());

    const shopLink = mobileNavigation().querySelector(
      'a[href="/shop"]',
    ) as HTMLAnchorElement;
    const main = document.getElementById("main-content")!;
    let mainFocuses = 0;
    main.addEventListener("focus", () => mainFocuses++);
    shopLink.focus();

    await click(shopLink);

    expect(mobileNavigation().hidden).toBe(true);
    expect(menuButton().getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("main h1")?.textContent).toBe("Shop content");
    expect(document.activeElement).toBe(menuButton());
    expect(mainFocuses).toBe(0);
  });

  it("returns to Home through the mobile navigation", async () => {
    await renderShell();
    await click(menuButton());
    await click(mobileNavigation().querySelector('a[href="/shop"]')!);

    await click(menuButton());
    await click(mobileNavigation().querySelector('a[href="/"]')!);

    expect(mobileNavigation().hidden).toBe(true);
    expect(menuButton().getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("main h1")?.textContent).toBe("Home content");
    expect(document.activeElement).toBe(
      document.getElementById("main-content"),
    );
  });

  it("focuses main after the destination route renders", async () => {
    await renderShell();
    const outside = document.getElementById("outside")!;
    const main = document.getElementById("main-content")!;
    const headingsAtFocus: string[] = [];
    main.addEventListener("focus", () => {
      headingsAtFocus.push(main.querySelector("h1")?.textContent ?? "");
    });
    outside.focus();
    await click(menuButton());

    await click(mobileNavigation().querySelector('a[href="/shop"]')!);

    expect(document.querySelector("main h1")?.textContent).toBe("Shop content");
    expect(document.activeElement).toBe(main);
    expect(headingsAtFocus).toEqual(["Shop content"]);
  });

  it("resets an open mobile menu on entering the desktop breakpoint", async () => {
    await renderShell();
    await click(menuButton());

    await act(async () => {
      for (const listener of mediaListeners) {
        listener({ matches: true } as MediaQueryListEvent);
      }
    });

    expect(mobileNavigation().hidden).toBe(true);
    expect(menuButton().getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      for (const listener of mediaListeners) {
        listener({ matches: false } as MediaQueryListEvent);
      }
    });
    expect(mobileNavigation().hidden).toBe(true);
  });
});
