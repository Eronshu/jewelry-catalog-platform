export function safeFacebookUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !["facebook.com", "www.facebook.com", "m.facebook.com"].includes(
        url.hostname,
      )
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}
