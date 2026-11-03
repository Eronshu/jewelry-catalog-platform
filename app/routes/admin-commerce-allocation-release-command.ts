import type { Route } from "./+types/admin-commerce-allocation-release-command";
import { actOwnerAllocationReleasePage } from "../lib/commerce/owner-allocation-release-http.server";
export const action = ({ request, context, params }: Route.ActionArgs) =>
  actOwnerAllocationReleasePage(request, context, params.orderId);
export const loader = action;
