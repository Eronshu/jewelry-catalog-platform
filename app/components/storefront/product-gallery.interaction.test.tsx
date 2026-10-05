// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProductGallery, type GalleryImage } from "./product-gallery";
import { ProductPhoto } from "./product-photo";

const images: GalleryImage[] = [
  {
    id: 2,
    altText: "Front",
    thumbUrl: "/2/thumb",
    detailUrl: "/2/detail",
    zoomUrl: "/2/zoom",
  },
  {
    id: 3,
    altText: "Side",
    thumbUrl: "/3/thumb",
    detailUrl: "/3/detail",
    zoomUrl: "/3/zoom",
  },
];
let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const originalComplete = Object.getOwnPropertyDescriptor(
  HTMLImageElement.prototype,
  "complete",
);
const originalNaturalWidth = Object.getOwnPropertyDescriptor(
  HTMLImageElement.prototype,
  "naturalWidth",
);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
  Object.defineProperty(HTMLImageElement.prototype, "complete", {
    configurable: true,
    get: () => false,
  });
  Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", {
    configurable: true,
    get: () => 1,
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  if (originalComplete)
    Object.defineProperty(
      HTMLImageElement.prototype,
      "complete",
      originalComplete,
    );
  if (originalNaturalWidth)
    Object.defineProperty(
      HTMLImageElement.prototype,
      "naturalWidth",
      originalNaturalWidth,
    );
});

async function activateByKeyboard(
  button: HTMLButtonElement,
  key: "Enter" | " ",
) {
  button.focus();
  await act(async () => {
    button.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    // Happy DOM does not synthesize a button click from the key event.
    button.click();
    button.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
  });
}

describe("product photo and gallery interaction", () => {
  it("switches photos using buttons and loads zoom only when inspection opens", async () => {
    await act(async () =>
      root.render(<ProductGallery name="Orbit Ring" images={images} />),
    );
    expect(
      container
        .querySelector(".product-gallery-main-photo img")
        ?.getAttribute("src"),
    ).toBe("/2/detail");
    expect(container.querySelector('img[src="/2/zoom"]')).toBeNull();
    const previous = container.querySelector<HTMLButtonElement>(
      '.product-gallery-arrow[aria-label="Previous photo"]',
    )!;
    const next = container.querySelector<HTMLButtonElement>(
      '.product-gallery-arrow[aria-label="Next photo"]',
    )!;
    expect(previous.getAttribute("aria-disabled")).toBe("true");
    expect(next.getAttribute("aria-disabled")).toBe("false");
    expect(
      container.querySelector(".product-gallery-position")?.textContent,
    ).toContain("1 / 2");
    expect(
      container.querySelectorAll('.product-gallery-marker[data-active="true"]'),
    ).toHaveLength(1);
    next.focus();
    expect(document.activeElement).toBe(next);
    await act(async () => next.click());
    expect(document.activeElement).toBe(next);
    expect(next.getAttribute("aria-disabled")).toBe("true");
    expect(previous.getAttribute("aria-disabled")).toBe("false");
    expect(
      container.querySelector(".product-gallery-position")?.textContent,
    ).toContain("2 / 2");
    expect(
      container
        .querySelector(".product-gallery-main-photo img")
        ?.getAttribute("src"),
    ).toBe("/3/detail");
    await act(async () => previous.click());
    expect(
      container
        .querySelector(".product-gallery-main-photo img")
        ?.getAttribute("src"),
    ).toBe("/2/detail");
    const second = container.querySelectorAll<HTMLButtonElement>(
      ".product-gallery-thumbnail",
    )[1];
    second.focus();
    await act(async () => second.click());
    expect(document.activeElement).toBe(second);
    expect(second.getAttribute("aria-pressed")).toBe("true");
    expect(
      container
        .querySelector(".product-gallery-main-photo img")
        ?.getAttribute("src"),
    ).toBe("/3/detail");

    const opener = container.querySelector<HTMLButtonElement>(
      ".product-gallery-inspect",
    )!;
    await act(async () => opener.click());
    expect(container.querySelector("dialog")?.hasAttribute("open")).toBe(true);
    expect(document.activeElement?.textContent).toBe("Close image");
    expect(container.querySelector('img[src="/3/zoom"]')).not.toBeNull();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".product-gallery-close")!
        .click(),
    );
    expect(container.querySelector("dialog")?.hasAttribute("open")).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("keeps endpoint arrows focused and ignores Enter and Space there", async () => {
    await act(async () =>
      root.render(<ProductGallery name="Orbit Ring" images={images} />),
    );
    const previous = container.querySelector<HTMLButtonElement>(
      '.product-gallery-arrow[aria-label="Previous photo"]',
    )!;
    const next = container.querySelector<HTMLButtonElement>(
      '.product-gallery-arrow[aria-label="Next photo"]',
    )!;
    const state = () => ({
      image: container
        .querySelector(".product-gallery-main-photo img")
        ?.getAttribute("src"),
      position: container.querySelector(".product-gallery-position")
        ?.textContent,
      activeMarker: [
        ...container.querySelectorAll(".product-gallery-marker"),
      ].findIndex((marker) => marker.getAttribute("data-active") === "true"),
    });

    expect(previous.disabled).toBe(false);
    expect(previous.getAttribute("aria-disabled")).toBe("true");
    for (const key of ["Enter", " "] as const) {
      await activateByKeyboard(previous, key);
      expect(document.activeElement).toBe(previous);
      expect(state()).toEqual({
        image: "/2/detail",
        position: "1 / 2",
        activeMarker: 0,
      });
    }

    await activateByKeyboard(next, "Enter");
    expect(document.activeElement).toBe(next);
    expect(next.getAttribute("aria-disabled")).toBe("true");
    expect(state()).toEqual({
      image: "/3/detail",
      position: "2 / 2",
      activeMarker: 1,
    });
    for (const key of ["Enter", " "] as const) {
      await activateByKeyboard(next, key);
      expect(document.activeElement).toBe(next);
      expect(state()).toEqual({
        image: "/3/detail",
        position: "2 / 2",
        activeMarker: 1,
      });
    }

    await activateByKeyboard(previous, " ");
    expect(document.activeElement).toBe(previous);
    expect(previous.getAttribute("aria-disabled")).toBe("true");
    expect(state()).toEqual({
      image: "/2/detail",
      position: "1 / 2",
      activeMarker: 0,
    });
  });

  it("shows a fallback after a failed image request", async () => {
    await act(async () =>
      root.render(<ProductPhoto src="/missing/card" alt="Orbit Ring" />),
    );
    const img = container.querySelector("img")!;
    await act(async () => img.dispatchEvent(new Event("error")));
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("Photo unavailable");
  });

  it("catches a server-rendered image that failed before hydration", async () => {
    const complete = Object.getOwnPropertyDescriptor(
      HTMLImageElement.prototype,
      "complete",
    );
    const naturalWidth = Object.getOwnPropertyDescriptor(
      HTMLImageElement.prototype,
      "naturalWidth",
    );
    const currentSrc = Object.getOwnPropertyDescriptor(
      HTMLImageElement.prototype,
      "currentSrc",
    );
    Object.defineProperty(HTMLImageElement.prototype, "complete", {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", {
      configurable: true,
      get: () => 0,
    });
    Object.defineProperty(HTMLImageElement.prototype, "currentSrc", {
      configurable: true,
      get: () => "/already-failed/card",
    });
    try {
      await act(async () =>
        root.render(
          <ProductPhoto src="/already-failed/card" alt="Orbit Ring" />,
        ),
      );
      expect(container.querySelector("img")).toBeNull();
      expect(container.textContent).toContain("Photo unavailable");
    } finally {
      if (complete)
        Object.defineProperty(HTMLImageElement.prototype, "complete", complete);
      if (naturalWidth)
        Object.defineProperty(
          HTMLImageElement.prototype,
          "naturalWidth",
          naturalWidth,
        );
      if (currentSrc)
        Object.defineProperty(
          HTMLImageElement.prototype,
          "currentSrc",
          currentSrc,
        );
    }
  });

  it("does not mistake an unrequested lazy image for a failed request", async () => {
    const currentSrc = Object.getOwnPropertyDescriptor(
      HTMLImageElement.prototype,
      "currentSrc",
    );
    Object.defineProperty(HTMLImageElement.prototype, "complete", {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", {
      configurable: true,
      get: () => 0,
    });
    Object.defineProperty(HTMLImageElement.prototype, "currentSrc", {
      configurable: true,
      get: () => "",
    });
    try {
      await act(async () =>
        root.render(
          <ProductPhoto src="/pending/thumb" alt="Orbit Ring" loading="lazy" />,
        ),
      );
      expect(
        container.querySelector('img[src="/pending/thumb"]'),
      ).not.toBeNull();
    } finally {
      if (currentSrc)
        Object.defineProperty(
          HTMLImageElement.prototype,
          "currentSrc",
          currentSrc,
        );
    }
  });

  it("renders an immediate fallback when no photo is saved", async () => {
    await act(async () =>
      root.render(<ProductGallery name="Orbit Ring" images={[]} />),
    );
    expect(container.textContent).toContain("Photo unavailable");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".product-gallery-arrow")).toBeNull();
    expect(container.querySelector(".product-gallery-position")).toBeNull();
    expect(container.querySelector(".product-gallery-inspect")).toBeNull();
  });

  it("shows one primary image and inspection without unnecessary navigation", async () => {
    await act(async () =>
      root.render(<ProductGallery name="Orbit Ring" images={[images[0]]} />),
    );
    expect(
      container
        .querySelector(".product-gallery-main-photo img")
        ?.getAttribute("src"),
    ).toBe("/2/detail");
    expect(container.querySelector(".product-gallery-arrow")).toBeNull();
    expect(container.querySelector(".product-gallery-position")).toBeNull();
    expect(container.querySelector(".product-gallery-thumbnail")).toBeNull();
    expect(container.querySelector(".product-gallery-inspect")).not.toBeNull();
  });
});
