import type { RouterContextProvider } from "react-router";
import { cloudflareContext } from "../../cloudflare-context";
import { requireAdmin } from "../auth/admin-access.server";
import { requireLocalCommerce } from "./environment.server";
import {
  lookupReservationRecovery,
  ReservationRecoveryError,
  type ReservationRecoveryLookup,
} from "./reservation-recovery.server";
import {
  inspectReservation,
  listReservationReview,
  ReservationReviewError,
} from "./reservation-review.server";

export const reviewHeaders = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
};

export type ReservationReviewView =
  | { kind: "list"; result: Awaited<ReturnType<typeof listReservationReview>> }
  | {
      kind: "detail";
      result: NonNullable<Awaited<ReturnType<typeof inspectReservation>>> & {
        recoveryLookup?: ReservationRecoveryLookup;
      };
    }
  | { kind: "error"; status: 400 | 404 | 405 | 503; message: string };

// The resource and owner screen share the same authorization, input and read boundary.
export async function readReservationReview(
  request: Request,
  context: Readonly<RouterContextProvider>,
): Promise<ReservationReviewView> {
  const actor = requireAdmin(context);
  const env = context.get(cloudflareContext).env;
  requireLocalCommerce(request, env);
  if (request.method !== "GET")
    return { kind: "error", status: 405, message: "Method Not Allowed" };
  try {
    const params = new URL(request.url).searchParams;
    if (
      [...params.keys()].some(
        (key) =>
          !["reference", "after", "requestId", "expectedVersion"].includes(key),
      ) ||
      [...params.keys()].some((key) => params.getAll(key).length > 1) ||
      (params.has("reference") && params.has("after")) ||
      params.has("requestId") !== params.has("expectedVersion") ||
      (params.has("requestId") &&
        (!params.has("reference") || params.has("after")))
    )
      throw new ReservationReviewError("invalid_request");
    if (params.has("reference")) {
      const reference = params.get("reference")!;
      let recoveryLookup;
      if (params.has("requestId")) {
        const requestId = params.get("requestId")!;
        const rawVersion = params.get("expectedVersion")!;
        const expectedVersion = Number(rawVersion);
        if (
          !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
            requestId,
          ) ||
          !/^[1-9][0-9]*$/.test(rawVersion) ||
          !Number.isSafeInteger(expectedVersion) ||
          expectedVersion >= Number.MAX_SAFE_INTEGER
        )
          throw new ReservationReviewError("invalid_request");
        // Reconstruct the fixed original confirmation; never accept an actor,
        // reason, confirmation or command hash from a read request.
        recoveryLookup = await lookupReservationRecovery(env.DB, actor, {
          requestId,
          reference,
          expectedVersion,
          confirmation: reference,
          reason: "overdue_unpaid",
        });
      }
      const result = await inspectReservation(env.DB, reference);
      return result
        ? {
            kind: "detail",
            result: {
              ...result,
              ...(recoveryLookup ? { recoveryLookup } : {}),
            },
          }
        : { kind: "error", status: 404, message: "Test reservation not found" };
    }
    const raw = params.get("after");
    let after;
    if (raw !== null) {
      if (raw.length > 160) throw new ReservationReviewError("invalid_request");
      try {
        after = JSON.parse(raw);
      } catch {
        throw new ReservationReviewError("invalid_request");
      }
    }
    return {
      kind: "list",
      result: await listReservationReview(env.DB, { after }),
    };
  } catch (error) {
    const invalid =
      (error instanceof ReservationReviewError ||
        error instanceof ReservationRecoveryError) &&
      error.code === "invalid_request";
    return {
      kind: "error",
      status: invalid ? 400 : 503,
      message: invalid
        ? "Invalid local review request"
        : "Local review temporarily unavailable",
    };
  }
}
