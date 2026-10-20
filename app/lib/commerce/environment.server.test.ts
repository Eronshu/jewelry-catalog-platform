import { describe, expect, it } from "vitest";

import {
  isLocalCommerceEnabled,
  requireLocalCommerce,
} from "./environment.server";

const localEnv = { COMMERCE_MODE: "local-test" };

describe("local commerce availability boundary", () => {
  it.each([
    "http://localhost/commerce",
    "http://localhost:5173/commerce?returnTo=https://example.com",
    "http://127.0.0.1:8787/commerce",
  ])("permits explicitly enabled local HTTP requests: %s", (url) => {
    const request = new Request(url);
    expect(isLocalCommerceEnabled(request, localEnv)).toBe(true);
    expect(() => requireLocalCommerce(request, localEnv)).not.toThrow();
    expect(
      isLocalCommerceEnabled(
        new Request(url, { headers: { Origin: new URL(url).origin } }),
        localEnv,
      ),
    ).toBe(true);
  });

  it.each([
    undefined,
    null,
    {},
    "local-test",
    [],
    { COMMERCE_MODE: undefined },
    { COMMERCE_MODE: true },
    { COMMERCE_MODE: "disabled" },
    { COMMERCE_MODE: "sandbox" },
    { COMMERCE_MODE: "live" },
    { COMMERCE_MODE: "production" },
    { COMMERCE_MODE: "LOCAL-TEST" },
    { COMMERCE_MODE: "local-test " },
    Object.create(localEnv) as unknown,
  ])("fails closed for absent or unexpected configuration: %j", (env) => {
    expect(
      isLocalCommerceEnabled(new Request("http://localhost:5173"), env),
    ).toBe(false);
  });

  it.each([
    "https://localhost:5173",
    "https://127.0.0.1",
    "http://[::1]:5173",
    "http://127.0.0.2:5173",
    "http://0.0.0.0:5173",
    "http://192.168.1.2:5173",
    "http://localhost.example.com:5173",
    "http://localhost.:5173",
    "http://example.com/?hostname=localhost",
    "https://example.workers.dev",
  ])("rejects non-allowlisted request origins: %s", (url) => {
    expect(isLocalCommerceEnabled(new Request(url), localEnv)).toBe(false);
  });

  it.each([
    "https://example.com",
    "null",
    "http://localhost:9999",
    "http://127.0.0.1:5173",
    "http://localhost:5173/",
    "http://localhost:5173 https://example.com",
    "",
  ])("rejects a supplied mismatched or malformed Origin: %s", (origin) => {
    const request = new Request("http://localhost:5173/commerce", {
      headers: { Origin: origin },
    });
    expect(isLocalCommerceEnabled(request, localEnv)).toBe(false);
  });

  it("does not enable remote requests using spoofed proxy or host headers", () => {
    const request = new Request("https://example.com/commerce", {
      headers: {
        Host: "localhost:5173",
        Origin: "http://localhost:5173",
        Forwarded: "host=localhost:5173;proto=http",
        "X-Forwarded-Host": "localhost:5173",
        "X-Forwarded-Proto": "http",
      },
    });
    expect(isLocalCommerceEnabled(request, localEnv)).toBe(false);
  });

  it("fails closed when configuration cannot be read", () => {
    const env = {
      get COMMERCE_MODE() {
        throw new Error("unavailable configuration");
      },
    };
    expect(
      isLocalCommerceEnabled(new Request("http://localhost:5173"), env),
    ).toBe(false);
  });

  it("returns an uncacheable 404 without exposing configuration", async () => {
    let response: Response | undefined;
    try {
      requireLocalCommerce(new Request("https://example.com/commerce"), {
        COMMERCE_MODE: "live",
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Response);
      response = error as Response;
    }
    expect(response?.status).toBe(404);
    expect(response?.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response?.text()).toBe("Not Found");
  });
});
