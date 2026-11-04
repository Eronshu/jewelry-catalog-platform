import type { Route } from "./+types/checkout-status-command";
import { cloudflareContext } from "../cloudflare-context";
import {
  actNotificationStatus,
  notificationHeaders,
} from "../lib/commerce/order-notification-http.server";
export const action = ({ request, context }: Route.ActionArgs) =>
  actNotificationStatus(request, context.get(cloudflareContext).env);
export const loader = action;
export const headers = () => notificationHeaders;
