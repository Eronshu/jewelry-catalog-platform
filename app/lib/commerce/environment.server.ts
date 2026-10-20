/**
 * Availability gate for local commerce development, not authentication or CSRF
 * protection. Callers must separately enforce permissions and local data bindings.
 */
export function isLocalCommerceEnabled(
  request: Request,
  env: unknown,
): boolean {
  try {
    if (
      typeof env !== "object" ||
      env === null ||
      Array.isArray(env) ||
      !Object.hasOwn(env, "COMMERCE_MODE") ||
      (env as Record<string, unknown>).COMMERCE_MODE !== "local-test"
    ) {
      return false;
    }

    const url = new URL(request.url);
    if (
      url.protocol !== "http:" ||
      (url.hostname !== "localhost" && url.hostname !== "127.0.0.1")
    ) {
      return false;
    }

    // Do not trust Host, Forwarded or X-Forwarded-Host to enable commerce.
    // A supplied Origin must also be local and exactly match, including port.
    const origin = request.headers.get("Origin");
    return origin === null || origin === url.origin;
  } catch {
    return false;
  }
}

export function requireLocalCommerce(request: Request, env: unknown): void {
  if (!isLocalCommerceEnabled(request, env)) {
    throw new Response("Not Found", {
      status: 404,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
}
