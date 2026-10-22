import { requireLocalCommerce } from "./environment.server";

export function readLocalPlacesKey(
  request: Request,
  env: unknown,
): string | null {
  requireLocalCommerce(request, env);
  const config = env as Record<string, unknown>;
  if (
    !Object.hasOwn(config, "COMMERCE_PLACES_MODE") ||
    config.COMMERCE_PLACES_MODE !== "google-test" ||
    !Object.hasOwn(config, "COMMERCE_PLACES_BROWSER_KEY") ||
    typeof config.COMMERCE_PLACES_BROWSER_KEY !== "string" ||
    !/^AIza[A-Za-z0-9_-]{35}$/.test(config.COMMERCE_PLACES_BROWSER_KEY)
  )
    return null;
  // Only the deliberately restricted browser key, never server/payment credentials.
  return config.COMMERCE_PLACES_BROWSER_KEY;
}
