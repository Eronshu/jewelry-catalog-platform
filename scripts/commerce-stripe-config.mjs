import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Explicit private file only. Never inherit a Stripe key or read repository dotenv. */
/** @param {Record<string, string | undefined>} env
 * @param {string} repository
 */
export function readStripeTestSettings(
  env,
  repository,
  filesystem = {
    stat: lstatSync,
    realpath: realpathSync,
    read: (/** @type {string} */ path) => readFileSync(path, "utf8"),
  },
) {
  const mode = env.COMMERCE_STRIPE_MODE;
  const path = env.COMMERCE_STRIPE_CONFIG_FILE;
  if (mode === undefined && path === undefined) return null;
  const invalid = () =>
    new Error(
      "Stripe Sandbox requires an explicit private configuration file outside the repository. No configuration values are logged.",
    );
  if (mode !== "sandbox" || typeof path !== "string" || !isAbsolute(path))
    throw invalid();
  let data;
  try {
    const stat = filesystem.stat(path);
    const actual = filesystem.realpath(path);
    const location = relative(filesystem.realpath(resolve(repository)), actual);
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
    data = JSON.parse(filesystem.read(actual));
  } catch {
    throw invalid();
  }
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    Object.keys(data).some(
      (key) => !["accountId", "testSecretKey", "signingSecret"].includes(key),
    ) ||
    typeof data.accountId !== "string" ||
    !/^acct_[A-Za-z0-9]{8,100}$/.test(data.accountId) ||
    typeof data.testSecretKey !== "string" ||
    !/^sk_test_[A-Za-z0-9]{16,240}$/.test(data.testSecretKey) ||
    (data.signingSecret !== undefined &&
      (typeof data.signingSecret !== "string" ||
        !/^whsec_[A-Za-z0-9]{16,240}$/.test(data.signingSecret)))
  )
    throw invalid();
  return {
    COMMERCE_STRIPE_TEST_SECRET: data.testSecretKey,
    COMMERCE_STRIPE_ACCOUNT_ID: data.accountId,
    ...(data.signingSecret
      ? { COMMERCE_STRIPE_SIGNING_SECRET: data.signingSecret }
      : {}),
  };
}
