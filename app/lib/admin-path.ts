export function isAdminPath(pathname: string): boolean {
  // React Router matches route paths without case sensitivity and decodes URL
  // segments. Its data requests also use a .data suffix. Match all of these
  // spellings at the Worker boundary before the route loader runs.
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape cannot match the admin route.
  }
  const normalized = decoded.toLowerCase();
  return (
    normalized === "/admin" ||
    normalized === "/admin.data" ||
    normalized.startsWith("/admin/")
  );
}
