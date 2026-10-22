// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlacesLibrary } from "./google-places.client";
const key = "AIza" + "x".repeat(35);
let scripts: HTMLScriptElement[];
let load: typeof import("./google-places.client").loadGooglePlaces;
type TestWindow = Window & {
  google?: { maps: { importLibrary: ReturnType<typeof vi.fn> } };
  __velaformPlacesReadyV1?: () => void;
};
const target = window as TestWindow;
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  delete target.google;
  delete target.__velaformPlacesReadyV1;
  scripts = [];
  // Intercept insertion: these tests must never send a request to Google.
  vi.spyOn(document.head, "appendChild").mockImplementation((node) => {
    scripts.push(node as unknown as HTMLScriptElement);
    return node;
  });
  load = (await import("./google-places.client")).loadGooglePlaces;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete target.google;
  delete target.__velaformPlacesReadyV1;
});
describe("explicit singleton Google SDK bootstrap, without network", () => {
  it("does not load until invoked and rejects invalid key configuration", async () => {
    expect(scripts).toHaveLength(0);
    await expect(load("invalid")).rejects.toThrow("unavailable");
    expect(scripts).toHaveLength(0);
  });
  it("loads once with minimal locale/referrer parameters and requests only places", async () => {
    const first = load(key),
      second = load(key);
    expect(first).toBe(second);
    expect(scripts).toHaveLength(1);
    const url = new URL(scripts[0].src);
    expect(url.origin + url.pathname).toBe(
      "https://maps.googleapis.com/maps/api/js",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      key,
      loading: "async",
      libraries: "places",
      callback: "__velaformPlacesReadyV1",
      v: "weekly",
      language: "en",
      region: "CA",
      auth_referrer_policy: "origin",
    });
    expect(scripts[0].referrerPolicy).toBe("origin");
    const library = {} as PlacesLibrary;
    target.google = {
      maps: { importLibrary: vi.fn().mockResolvedValue(library) },
    };
    target.__velaformPlacesReadyV1!();
    await expect(first).resolves.toBe(library);
    expect(target.google.maps.importLibrary).toHaveBeenCalledWith("places");
    expect(load(key)).toBe(first);
    await expect(load("AIza" + "y".repeat(35))).rejects.toThrow(
      "configuration changed",
    );
  });
  it("uses generic network failure and does not keep retrying or echo keys", async () => {
    const promise = load(key);
    const check = expect(promise).rejects.toThrow("Address search unavailable");
    scripts[0].dispatchEvent(new Event("error"));
    await check;
    expect(load(key)).toBe(promise);
    expect(scripts).toHaveLength(1);
  });
  it.each(["throw", "reject"])(
    "handles a library %s without leaking SDK errors or leaving bootstrap pending",
    async (kind) => {
      const promise = load(key);
      const check = expect(promise).rejects.toThrow(
        "Address search unavailable",
      );
      target.google = {
        maps: {
          importLibrary: vi.fn(() => {
            if (kind === "throw") throw new Error("private provider error");
            return Promise.reject(new Error("private provider error"));
          }),
        },
      };
      target.__velaformPlacesReadyV1!();
      await check;
      expect(load(key)).toBe(promise);
      expect(scripts).toHaveLength(1);
    },
  );
  it("times out SDK loading, ignores a late callback and does not adopt unknown globals", async () => {
    const promise = load(key);
    const check = expect(promise).rejects.toThrow("unavailable");
    await vi.advanceTimersByTimeAsync(10_001);
    await check;
    target.google = { maps: { importLibrary: vi.fn() } };
    target.__velaformPlacesReadyV1!();
    expect(target.google.maps.importLibrary).not.toHaveBeenCalled();
  });
  it("refuses to reuse an SDK loaded under another account", async () => {
    target.google = { maps: { importLibrary: vi.fn() } };
    await expect(load(key)).rejects.toThrow("unavailable");
    expect(scripts).toHaveLength(0);
  });
});
