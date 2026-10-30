import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const root = resolve("build/client");
const generated = JSON.parse(
  readFileSync(resolve("build/server/wrangler.json"), "utf8"),
);
const patterns = generated.assets?.run_worker_first;
if (
  !Array.isArray(patterns) ||
  ![
    "/admin",
    "/admin.data",
    "/admin/*",
    "/checkout",
    "/checkout.data",
    "/checkout/*",
  ].every((path) => patterns.includes(path))
) {
  throw new Error(
    "Generated Static Assets config omits an Admin Worker-first path.",
  );
}

function isAdminPath(pathname) {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // Even malformed escapes must not be shipped in the Admin asset namespace.
  }
  const normalized = decoded.toLowerCase();
  return (
    normalized === "/admin" ||
    normalized === "/admin.data" ||
    normalized.startsWith("/admin/") ||
    normalized === "/checkout" ||
    normalized === "/checkout.data" ||
    normalized.startsWith("/checkout/")
  );
}

function inspect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      inspect(path);
    } else if (entry.isFile()) {
      const urlPath = `/${relative(root, path).split(sep).join("/")}`;
      if (isAdminPath(urlPath)) {
        throw new Error(`Static asset would occupy an Admin path: ${urlPath}`);
      }
    }
  }
}

inspect(root);
console.log(
  "Generated Admin Worker-first paths and static asset names checked.",
);
