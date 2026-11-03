import type { Route } from "./+types/admin-commerce-return-command";
import { actOwnerReturnPage } from "../lib/commerce/owner-return-http.server";
export const action = ({ request, context, params }: Route.ActionArgs) =>
  actOwnerReturnPage(request, context, params.orderId);
export const loader = action;
