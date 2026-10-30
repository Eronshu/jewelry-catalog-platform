import type { Route } from "./+types/admin-commerce-order";
import { loadCommerceWorkspace } from "../lib/commerce/workspace.server";
export const loader = ({ request, context, params }: Route.LoaderArgs) =>
  loadCommerceWorkspace(request, context, "order", params.orderId);
export const action = loader;
export { default, headers, meta, ErrorBoundary } from "./admin-commerce";
