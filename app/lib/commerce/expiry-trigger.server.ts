import {
  checkoutConfig,
  checkoutExpiryConfigured,
} from "./checkout-config.server";
import { expireOwnedCheckoutBatch } from "./checkout-expiry.server";
import { isLocalCommerceEnabled } from "./environment.server";
import { expireTestOrderBatch } from "./order-expiry.server";
import { OrderError } from "./orders.server";

export const LOCAL_EXPIRY_PATH = "/_local/commerce/expiry";
const headers = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
};

// This capability never goes into route loader data, URLs, cookies or logs.
export function localExpiryConfigured(env: unknown): boolean {
  if (!env || typeof env !== "object") return false;
  const settings = env as Record<string, unknown>;
  return (
    Object.hasOwn(settings, "COMMERCE_LOCAL_EXPIRY_TOKEN") &&
    typeof settings.COMMERCE_LOCAL_EXPIRY_TOKEN === "string" &&
    /^[a-f0-9]{64}$/.test(settings.COMMERCE_LOCAL_EXPIRY_TOKEN)
  );
}

export async function handleLocalExpiry(
  request: Request,
  env: Env,
): Promise<Response> {
  const settings = env as unknown as Record<string, unknown>;
  const url = new URL(request.url);
  if (
    !isLocalCommerceEnabled(request, env) ||
    !localExpiryConfigured(env) ||
    request.headers.get("Origin") !== url.origin ||
    request.headers.get("Authorization") !==
      `Bearer ${settings.COMMERCE_LOCAL_EXPIRY_TOKEN}`
  )
    return new Response("Not Found", { status: 404, headers });
  if (request.method !== "POST")
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { ...headers, Allow: "POST" },
    });
  if (url.search || request.headers.get("Content-Type") !== "application/json")
    return new Response("Invalid local expiry request", {
      status: 400,
      headers,
    });

  let input: {
    after?: { reserveUntil: number; orderId: string };
    ownedAfter?: { reserveUntil: number; orderId: string };
  };
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 512) {
          await reader.cancel();
          throw new Error();
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (key) => key !== "after" && key !== "ownedAfter",
      ) ||
      (Object.hasOwn(input, "after") &&
        (!input.after ||
          typeof input.after !== "object" ||
          Array.isArray(input.after) ||
          Object.keys(input.after).some(
            (key) => key !== "reserveUntil" && key !== "orderId",
          ))) ||
      (Object.hasOwn(input, "ownedAfter") &&
        (!input.ownedAfter ||
          typeof input.ownedAfter !== "object" ||
          Array.isArray(input.ownedAfter) ||
          Object.keys(input.ownedAfter).some(
            (key) => key !== "reserveUntil" && key !== "orderId",
          )))
    )
      throw new Error();
    // Validate both cursors before either scan can perform a release.
    for (const cursor of [input.after, input.ownedAfter]) {
      if (
        cursor &&
        (!Number.isSafeInteger(cursor.reserveUntil) ||
          cursor.reserveUntil < 0 ||
          cursor.reserveUntil > Date.now() ||
          typeof cursor.orderId !== "string" ||
          !/^order-[a-f0-9-]{36}$/.test(cursor.orderId))
      )
        throw new Error();
    }
    if (
      input.ownedAfter !== undefined &&
      !checkoutExpiryConfigured(request, env)
    )
      throw new Error();
  } catch {
    return new Response("Invalid local expiry request", {
      status: 400,
      headers,
    });
  }
  try {
    // Clock and batch size are server controlled. No caller-supplied DB or owner.
    const result = await expireTestOrderBatch(env.DB, {
      after: input.after,
      signal: request.signal,
    });
    if (checkoutExpiryConfigured(request, env)) {
      const owned = await expireOwnedCheckoutBatch(
        env.DB,
        checkoutConfig(request, env),
        { after: input.ownedAfter, signal: request.signal },
      );
      return Response.json({ ...result, owned }, { headers });
    }
    if (input.ownedAfter !== undefined) throw new OrderError("invalid_request");
    return Response.json(result, { headers });
  } catch (error) {
    return new Response(
      error instanceof OrderError
        ? "Invalid local expiry request"
        : "Local expiry temporarily unavailable",
      { status: error instanceof OrderError ? 400 : 503, headers },
    );
  }
}
