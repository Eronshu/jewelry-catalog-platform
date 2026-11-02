import type { Route } from "./+types/admin-commerce-refund-command";
import { actOwnerRefundPage } from "../lib/commerce/owner-refund-http.server";
// JSON resource route: native fetch must never receive a document render.
export const action = ({ request, context, params }: Route.ActionArgs) =>
  actOwnerRefundPage(request, context, params.orderId);
export const loader = action;
export { headers } from "./admin-commerce";
