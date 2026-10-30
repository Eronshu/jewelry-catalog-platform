import type { Route } from "./+types/admin-commerce-inventory";
import { loadCommerceWorkspace } from "../lib/commerce/workspace.server";
export const loader = ({ request, context }: Route.LoaderArgs) =>
  loadCommerceWorkspace(request, context, "inventory");
export const action = loader;
export { default, headers, meta, ErrorBoundary } from "./admin-commerce";
