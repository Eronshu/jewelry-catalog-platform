import { describe, expect, it } from "vitest";
import {
  readCommerceForm,
  readTestSession,
  testSession,
} from "./request.server";
const base = "http://localhost:5173/commerce-lab";
function post(body = "intent=quote", headers: Record<string, string> = {}) {
  return new Request(base, {
    method: "POST",
    headers: {
      Origin: "http://localhost:5173",
      "Content-Type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body,
  });
}
describe("local test request boundaries", () => {
  it("creates a private high entropy session and reuses its owner without reissuing cookie", async () => {
    const first = await testSession(new Request(base));
    expect(first.owner).toMatch(/^[a-f0-9]{64}$/);
    expect(first.cookie).toContain("HttpOnly; SameSite=Strict; Path=/");
    const second = await testSession(
      new Request(base, { headers: { Cookie: first.cookie!.split(";")[0] } }),
    );
    expect(second).toEqual({ owner: first.owner, cookie: null });
    expect((await testSession(new Request(base))).owner).not.toBe(first.owner);
  });
  it("rejects ambiguous or malformed cookies", () => {
    for (const Cookie of [
      "commerce_lab_session_v1=bad",
      `commerce_lab_session_v1=${"a".repeat(64)}; commerce_lab_session_v1=${"b".repeat(64)}`,
    ])
      expect(
        readTestSession(new Request(base, { headers: { Cookie } })),
      ).toBeNull();
  });
  it("requires exact Origin, POST and form content type", async () => {
    await expect(readCommerceForm(new Request(base))).rejects.toMatchObject({
      status: 405,
    });
    await expect(
      readCommerceForm(post("", { Origin: "null" })),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      readCommerceForm(post("", { Origin: "http://localhost:9999" })),
    ).rejects.toMatchObject({ status: 403 });
    const missing = post();
    missing.headers.delete("Origin");
    await expect(readCommerceForm(missing)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      readCommerceForm(post("{}", { "Content-Type": "application/json" })),
    ).rejects.toMatchObject({ status: 415 });
  });
  it("enforces actual streamed size even when declared length lies or is absent", async () => {
    await expect(
      readCommerceForm(
        post("x=" + "a".repeat(9000), { "Content-Length": "1" }),
      ),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      readCommerceForm(post("x=" + "a".repeat(9000))),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      readCommerceForm(post("x=1", { "Content-Length": "-1" })),
    ).rejects.toMatchObject({ status: 413 });
  });
  it("refuses duplicate keys and decodes a bounded form", async () => {
    await expect(
      readCommerceForm(post("intent=quote&intent=reserve")),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      (await readCommerceForm(post("intent=quote&lines=%5B%5D"))).get("lines"),
    ).toBe("[]");
  });
});
