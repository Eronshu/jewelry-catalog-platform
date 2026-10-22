/** @param {string | undefined} value */
export function readCommerceLocalPort(value) {
  const raw = value ?? "8791";
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < 1024 || port > 65535)
    throw new Error(
      "COMMERCE_LOCAL_PORT must be an integer from 1024 to 65535.",
    );
  // Use the same canonical spelling for Wrangler, links and capability Origin.
  return String(port);
}
