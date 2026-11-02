import type { Route } from "./+types/admin-commerce-fulfillment-command";
import { actOwnerFulfillmentPage } from "../lib/commerce/owner-fulfillment-http.server";
// JSON resource route: native fetch must never receive a document render.
export const action = ({ request, context, params }: Route.ActionArgs) =>
  actOwnerFulfillmentPage(request, context, params.orderId);
export const loader = action;
export { headers } from "./admin-commerce";
