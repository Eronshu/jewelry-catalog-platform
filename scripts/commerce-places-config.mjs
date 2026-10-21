import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

// No inherited key lookup or repository dotenv loading. Actual provider testing
// requires a deliberate mode plus the absolute path of a user-created key file.
/** @param {Record<string, string | undefined>} env
 * @param {(path: string, encoding: "utf8") => string} read
 */
export function readPlacesTestSettings(
  env,
  read = (path, encoding) => readFileSync(path, encoding),
) {
  const mode = env.COMMERCE_PLACES_MODE;
  const path = env.COMMERCE_PLACES_KEY_FILE;
  if (mode === undefined && path === undefined) return null;
  if (mode !== "google-test" || typeof path !== "string" || !isAbsolute(path)) {
    throw new Error(
      "Google test mode requires an explicit absolute key-file path.",
    );
  }
  let key;
  try {
    key = read(path, "utf8").trim();
  } catch {
    throw new Error("Google test configuration could not be read.");
  }
  if (!/^AIza[A-Za-z0-9_-]{35}$/.test(key)) {
    throw new Error("Google test browser key is invalid.");
  }
  return {
    COMMERCE_PLACES_MODE: "google-test",
    COMMERCE_PLACES_BROWSER_KEY: key,
  };
}
