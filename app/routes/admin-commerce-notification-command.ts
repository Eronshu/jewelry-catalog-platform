import type { Route } from "./+types/admin-commerce-notification-command";
import {
  actOwnerNotificationPage,
  notificationHeaders,
} from "../lib/commerce/order-notification-http.server";
export const action = ({ request, context, params }: Route.ActionArgs) =>
  actOwnerNotificationPage(request, context, params.orderId);
export const loader = action;
export const headers = () => notificationHeaders;
