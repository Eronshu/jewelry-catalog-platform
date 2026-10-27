# C06b2b1: audited recovery of an expired unpaid test reservation

Status: this feature branch, pending CI/independent review/merge. Built from #47/main `7558a17`. This is a server command and additive migration, not a finished owner recovery interface. The existing review page remains read only. No merchant credentials, real customer data, provider calls, production migration or deployment are involved.

## One deliberately narrow operation

An approved operator can expire one test order across lab sessions, without borrowing its customer's cookie. All of these must still hold at the database write:

- Order exists, is `pending_payment`, and has the exact version the operator reviewed.
- Payment is `not_started`. Processing, unknown, successful **and failed** payment records need separate reconciliation and cannot be released here.
- Fulfillment is `none`. A hold or other fulfillment state cannot be overridden.
- Stored reservation deadline has passed according to the server's captured time. The client cannot supply a clock or replace the deadline.
- The order has1–20 stored lines. Release quantities and variant references come from those lines, never client input.

The outcome is the existing expiry transition: order becomes `cancelled`, its version increments, and only its own checkout reservations are released. This does not reduce physical stock, Facebook reserves or another order's reservation, record a refund, verify payment, reassign ownership or reopen an order. The15-minute reservation duration remains a fictional lab constant, not an approved customer policy.

## Authorization and confirmation contract

`POST /admin/commerce/reservations/recover` is an Admin resource. Worker approved-human Access verification and the route's independent `requireAdmin` run before storage. Explicit HTTP loopback commerce mode and an exact Origin are also required. The expiry bearer and customer lab cookie are not operator identities. Default/remote mode is disabled; the standard local runner still supplies no Access setup or bypass.

The body is URL-encoded, bounded to8KiB, with exactly one each of:

| Field             | Meaning                                                                   |
| ----------------- | ------------------------------------------------------------------------- |
| `requestId`       | UUIDv4 retained for this attempt and all uncertain-result retries         |
| `reference`       | Complete validated test order reference from review                       |
| `expectedVersion` | Positive safe integer from the reviewed order; canonical decimal spelling |
| `confirmation`    | Exact same reference, explicitly acknowledging this particular order      |
| `reason`          | Fixed `overdue_unpaid`; no free-text notes/customer details               |

Unknown/duplicate fields, query parameters, malformed values and mismatched confirmation are rejected before D1. The client cannot specify the actor, stock quantities, payment/order state, time or arbitrary operation. GET/PUT/DELETE return405/Allow:POST after authorization/local gating, without reading or writing records. Responses/errors are private/no-store and noindex, with generic errors rather than submitted values or database details. Request bodies must not be added to infrastructure logs; log-retention policy remains an operating gate before real data.

This protocol binds confirmation to reference/version; it does not prove that a human actually viewed a page. The next UI task must present current state/consequences, obtain explicit confirmation, retain the same request ID/details while an outcome is uncertain, and refresh after a conflict. It must not automatically submit from list render, navigation, refresh or a timeout. No owner-facing action is added by this PR.

## Atomic audit, idempotency and uncertainty

Migration0008 adds `commerce_reservation_recoveries` and an order index. A two-statement D1 batch inserts the immutable command and recovery audit. The audit trigger rechecks current eligibility, expected version, server time and line bounds, then inserts the existing `expire` transition;0006 and the stock triggers check again and release the stored lines. Any failure rolls back command, audit, transition, every stock movement and order update together. Ordinary customer cancellation and the existing expiry engine are unchanged.

The audit contains command/order references, reviewed version, server timestamp, fixed reason and a SHA-256 digest of the trusted operator email/sub under a versioned actor scheme. It stores no raw email/sub, snapshot, customer details or cookie. **This is pseudonymous attribution, not anonymous data.** An authorized developer can derive a digest from the approved identity configuration for incident investigation; access/retention/identity-change procedures need review before production. UI exposure of raw identity or actor hashes is not enabled.

The command key is `recovery-{requestId}`; a canonical hash binds the operation, actor and all confirmed fields independently of object property order. An identical replay returns the original durable receipt without releasing twice. Reusing the key for another actor, order or reviewed version returns409. A cancelled record without that exact receipt is not reported as this command's success. A recovery/ordinary-expiry race creates at most one release; the losing recovery receives conflict. Before rejecting a changed order state, both preflight and failed-batch reconciliation recheck durable receipt: an identical request may have committed between the preceding receipt lookup and order read. Those two interleavings have deterministic regression tests; a successful replay is not mislabeled as a conflict.

A successful receipt contains only `testOnly`, request/reference, expected/resulting version, first recorded time and replay flag. It proves that this specific test command was recorded, **not** the current order/payment state or financial reconciliation. Subsequent review is a separate read. No customer capability or actor digest is returned.

After a lost batch response the service checks durable audit. If it cannot establish a receipt,503 says to retain the same request ID and details and investigate/retry that same request; never generate a replacement ID or force release. A conflict requires fresh review. A developer investigates uncertain storage outcomes, stale/conflicting commands or stock discrepancies. The owner must not resolve payment/held cases through this endpoint; those need separately designed reconciliation/operational handling.

## Acceptance, rollout and rollback

Automated coverage includes a real temporary D1 upgrade from0007 with an existing reservation, unchanged legacy records, own-line release with Facebook/other-owner preservation, immutable audit, identical/different simultaneous requests, canonical replay and actor/payload conflict, ordinary expiry winning a race, all payment/held/version/future-deadline races, nonexistent/stale/cancelled records, later-line stock failure rolling back the entire operation, lost response and lost audit read, and pre-storage validation. Worker→real React Router tests cover unapproved/absent/service identity, `.data` authorization, direct route denial, local/Origin gates, POST-only behavior, strict form/size, approved minimal receipt, generic conflict/outage and no-store.

Run the full repository validation before completion and record actual results in the execution log/PR. These tests are not provider Sandbox or owner browser acceptance. No UI changed; the previous390px presentation evidence is not evidence for a recovery confirmation flow. Real authorized browser, keyboard/screen-reader and real iPhone Safari/UAT for that future UI remain outstanding. Actual Stripe/PayPal/payment-reconciliation gates are unchanged.

Roll out only as reviewed local code against isolated fixtures. If migration0008 is absent, recovery fails closed; do not fall back to unaudited release. Stop by disabling local commerce or removing/reverting this command route/service. Retain0008 audit/index/triggers,0006/0007, commands, orders and stock history; earlier code can ignore the added table. A committed release cannot be undone by reverting code: do not delete audit, edit balances or recreate the original reservation as rollback. Any genuine corrective stock/order action needs its own reviewed command.

After this PR is reviewed and merged, build the minimal operator confirmation/result UI and its reviewable audit presentation as a separate task, then resolve remaining #44 acceptance before moving to persistent payment attempts/events. Do not stack that UI or a payment button in this branch.
