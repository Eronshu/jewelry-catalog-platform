import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Explicit private external file only; opaque credentials are not distinguished by a test prefix.
 * @param {Record<string, string | undefined>} env
 * @param {string} repository
 */
export function readPayPalTestSettings(env, repository) {
  const mode = env.COMMERCE_PAYPAL_MODE,
    path = env.COMMERCE_PAYPAL_CONFIG_FILE;
  if (mode === undefined && path === undefined) return null;
  const invalid = () =>
    new Error(
      "PayPal Sandbox requires a private configuration file outside the repository. No configuration values are logged.",
    );
  if (mode !== "sandbox" || typeof path !== "string" || !isAbsolute(path))
    throw invalid();
  let data;
  try {
    const stat = lstatSync(path),
      actual = realpathSync(path),
      location = relative(realpathSync(resolve(repository)), actual);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 8192 ||
      location === "" ||
      (!location.startsWith(`..${sep}`) &&
        location !== ".." &&
        !isAbsolute(location))
    )
      throw invalid();
    data = JSON.parse(readFileSync(actual, "utf8"));
  } catch {
    throw invalid();
  }
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    Object.keys(data).some(
      (k) =>
        !["merchantId", "clientId", "clientSecret", "webhookId"].includes(k),
    ) ||
    typeof data.merchantId !== "string" ||
    !/^[2-9A-HJ-NP-Z]{13}$/.test(data.merchantId) ||
    typeof data.clientId !== "string" ||
    !/^[\x21-\x39\x3B-\x7E]{16,512}$/.test(data.clientId) ||
    typeof data.clientSecret !== "string" ||
    !/^[\x21-\x7E]{16,512}$/.test(data.clientSecret) ||
    (data.webhookId !== undefined &&
      (typeof data.webhookId !== "string" ||
        !/^[A-Za-z0-9]{1,50}$/.test(data.webhookId)))
  )
    throw invalid();
  return {
    COMMERCE_PAYPAL_MERCHANT_ID: data.merchantId,
    COMMERCE_PAYPAL_CLIENT_ID: data.clientId,
    COMMERCE_PAYPAL_CLIENT_SECRET: data.clientSecret,
    ...(data.webhookId ? { COMMERCE_PAYPAL_WEBHOOK_ID: data.webhookId } : {}),
  };
}
