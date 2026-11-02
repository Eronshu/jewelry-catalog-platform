import type { Route } from "./+types/admin-commerce-stock-command";
import { actOwnerStockPage } from "../lib/commerce/owner-stock-http.server";
// Resource route: no UI export. Native fetch must receive the action JSON, never a document render.
export const action = ({ request, context, params }: Route.ActionArgs) =>
  actOwnerStockPage(request, context, params.variantId);
export const loader = action;
export { headers } from "./admin-commerce";
