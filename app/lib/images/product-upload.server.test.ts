import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  boundedPhotoBody,
  rejectAnimation,
  sniffPhoto,
} from "./product-upload.server";

function webpChunk(name: string, body: number[]) {
  const bytes = new Uint8Array(8 + body.length + (body.length & 1));
  bytes.set(new TextEncoder().encode(name));
  new DataView(bytes.buffer).setUint32(4, body.length, true);
  bytes.set(body, 8);
  return bytes;
}
function webp(chunks: Uint8Array[]) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 12);
  const bytes = new Uint8Array(length);
  bytes.set(new TextEncoder().encode("RIFF"));
  new DataView(bytes.buffer).setUint32(4, length - 8, true);
  bytes.set(new TextEncoder().encode("WEBP"), 8);
  let at = 12;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

describe("photo format validation", () => {
  it("rejects unsupported and empty bytes", () => {
    expect(() => sniffPhoto(new Uint8Array())).toThrow(/JPEG, PNG/);
    expect(() => sniffPhoto(new TextEncoder().encode("not an image"))).toThrow(
      /JPEG, PNG/,
    );
  });
  it("rejects animated WebP from its container flags and chunks", () => {
    const format = { contentType: "image/webp", extension: "webp" } as const;
    expect(() =>
      rejectAnimation(
        webp([webpChunk("VP8X", [2, 0, 0, 0, 0, 0, 0, 0, 0, 0])]),
        format,
      ),
    ).toThrow(/Animated/);
    expect(() =>
      rejectAnimation(webp([webpChunk("ANIM", [0, 0, 0, 0, 0, 0])]), format),
    ).toThrow(/Animated/);
    expect(() =>
      rejectAnimation(webp([webpChunk("VP8 ", [0])]), format),
    ).not.toThrow();
  });
  it("rejects real two-frame WebP and APNG fixtures", () => {
    for (const name of ["animated-photo.webp", "animated-photo.png"]) {
      const bytes = readFileSync(resolve("tests/fixtures", name));
      const format = sniffPhoto(bytes);
      expect(() => rejectAnimation(bytes, format)).toThrow(/Animated/);
    }
  });
  it("enforces a byte bound even without a trustworthy length header", async () => {
    const request = new Request("https://example.invalid/upload", {
      method: "POST",
      body: new Uint8Array(18_000_001),
    });
    await expect(boundedPhotoBody(request)).rejects.toThrow(/too large/);
  });
});
