import type { Route } from "./+types/admin-commerce-recover";
import { cloudflareContext } from "../cloudflare-context";
import { requireAdmin } from "../lib/auth/admin-access.server";
import { requireLocalCommerce } from "../lib/commerce/environment.server";
import { readCommerceForm } from "../lib/commerce/request.server";
import {
  recoverExpiredReservation,
  ReservationRecoveryError,
} from "../lib/commerce/reservation-recovery.server";

const headers = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
};
export async function action({ request, context }: Route.ActionArgs) {
  const actor = requireAdmin(context);
  const env = context.get(cloudflareContext).env;
  requireLocalCommerce(request, env);
  if (request.method !== "POST")
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { ...headers, Allow: "POST" },
    });
  try {
    if (new URL(request.url).search)
      throw new ReservationRecoveryError("invalid_request");
    const form = await readCommerceForm(request);
    const keys = [
      "requestId",
      "reference",
      "expectedVersion",
      "confirmation",
      "reason",
    ];
    if (
      [...form.keys()].some((key) => !keys.includes(key)) ||
      keys.some((key) => !form.has(key)) ||
      !/^[1-9][0-9]{0,15}$/.test(form.get("expectedVersion")!)
    )
      throw new ReservationRecoveryError("invalid_request");
    if (form.get("reason") !== "overdue_unpaid")
      throw new ReservationRecoveryError("invalid_request");
    const result = await recoverExpiredReservation(env.DB, actor, {
      requestId: form.get("requestId")!,
      reference: form.get("reference")!,
      expectedVersion: Number(form.get("expectedVersion")),
      confirmation: form.get("confirmation")!,
      reason: "overdue_unpaid",
    });
    return Response.json(result, { headers });
  } catch (error) {
    if (error instanceof Response)
      return new Response("Invalid local recovery request", {
        status: error.status,
        headers,
      });
    const code =
      error instanceof ReservationRecoveryError ? error.code : "unavailable";
    const errors = {
      invalid_request: [400, "Invalid local recovery request"],
      not_found: [404, "Test reservation not found"],
      conflict: [
        409,
        "Reservation or request changed. Review the record; do not force a release.",
      ],
      unavailable: [
        503,
        "Recovery outcome could not be confirmed. Keep the same request ID and details; review before retrying.",
      ],
    } as const;
    return new Response(errors[code][1], { status: errors[code][0], headers });
  }
}
export const loader = action;
