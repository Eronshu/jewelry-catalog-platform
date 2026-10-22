import { describe, expect, it, vi } from "vitest";
import { handleLocalExpiry, LOCAL_EXPIRY_PATH } from "./expiry-trigger.server";
import { handleWorkerRequest } from "../../../workers/app";

const token = "c".repeat(64); // Fictional capability, never a real credential.
const origin = "http://127.0.0.1:8792";
function settings(overrides = {}) {
  return {
    COMMERCE_MODE: "local-test",
    COMMERCE_LOCAL_EXPIRY_TOKEN: token,
    ...overrides,
  } as unknown as Env;
}
function request(
  body = "{}",
  options: RequestInit = {},
  url = origin + LOCAL_EXPIRY_PATH,
) {
  return new Request(url, {
    method: "POST",
    body,
    headers: {
      Origin: origin,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...options,
  });
}
describe("local expiry capability boundary", () => {
  it.each([
    ["default environment", request(), {}],
    ["wrong mode", request(), settings({ COMMERCE_MODE: "production" })],
    [
      "no capability",
      request(),
      settings({ COMMERCE_LOCAL_EXPIRY_TOKEN: undefined }),
    ],
    [
      "weak capability",
      request(),
      settings({ COMMERCE_LOCAL_EXPIRY_TOKEN: "short" }),
    ],
    [
      "missing authorization",
      request("{}", { headers: { Origin: origin } }),
      settings(),
    ],
    [
      "missing origin",
      request("{}", { headers: { Authorization: `Bearer ${token}` } }),
      settings(),
    ],
    [
      "wrong origin",
      request("{}", {
        headers: {
          Origin: "http://localhost:8792",
          Authorization: `Bearer ${token}`,
        },
      }),
      settings(),
    ],
    [
      "wrong token",
      request("{}", {
        headers: { Origin: origin, Authorization: `Bearer ${"d".repeat(64)}` },
      }),
      settings(),
    ],
    [
      "remote URL",
      request("{}", {}, "https://shop.example.invalid" + LOCAL_EXPIRY_PATH),
      settings(),
    ],
    [
      "spoofed forwarding",
      request(
        "{}",
        {
          headers: {
            Origin: origin,
            Authorization: `Bearer ${token}`,
            "X-Forwarded-Host": "127.0.0.1",
          },
        },
        "http://shop.example.invalid" + LOCAL_EXPIRY_PATH,
      ),
      settings(),
    ],
  ])("denies %s before storage or router access", async (_name, req, env) => {
    const route = vi.fn();
    const response = await handleWorkerRequest(
      req as Request,
      env as Env,
      {} as ExecutionContext,
      route,
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(route).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain(token);
  });
  it("uses an authenticated read-only readiness request", async () => {
    const response = await handleLocalExpiry(
      request("", { method: "GET", body: undefined }),
      settings(),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
  });
  it.each([
    "not-json",
    "null",
    "[]",
    '{"now":0}',
    '{"limit":100}',
    '{"owner":"ignored"}',
    '{"after":null}',
    '{"after":{"reserveUntil":0,"orderId":"bad"}}',
    '{"after":{"reserveUntil":0,"orderId":"bad","extra":1}}',
    " ".repeat(513),
  ])("rejects invalid input without a database: %s", async (body) => {
    expect((await handleLocalExpiry(request(body), settings())).status).toBe(
      400,
    );
  });
  it("rejects query parameters and non-JSON content", async () => {
    expect(
      (
        await handleLocalExpiry(
          request("{}", {}, origin + LOCAL_EXPIRY_PATH + "?now=0"),
          settings(),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleLocalExpiry(
          request("{}", {
            headers: {
              Origin: origin,
              Authorization: `Bearer ${token}`,
              "Content-Type": "text/plain",
            },
          }),
          settings(),
        )
      ).status,
    ).toBe(400);
  });
  it("hides scan failure details and never echoes the capability", async () => {
    const response = await handleLocalExpiry(
      request(),
      settings({
        DB: {
          prepare: () => {
            throw new Error("private database details");
          },
        },
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Local expiry temporarily unavailable");
  });
});
