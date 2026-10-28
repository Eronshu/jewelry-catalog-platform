# C06b2b1: audited recovery of an expired unpaid test reservation

Status checked 2026-10-27: #48 command/migration and #50 L01 confirmation/result/read-only receipt/audit UI are merged into main `8701e52`. L01 head `30a67f2` passed CI71 and independent review with no findings; merged-main CI72 passed. A separate bounded audit resolved the original #48 race discussion, without claiming its stalled GitHub bot re-review completed. Local724 application tests/6 payment HTTP mocks and full checks passed for L01; actual Access browser/iPhone/UAT/provider acceptance remains open. The next L02a [isolation contract](./COMMERCE_SANDBOX_BOUNDARY.md) does not enable remote mode, credentials, payment or deployment.

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

This protocol binds confirmation to reference/version; it does not prove that a human actually viewed a page. The separate L01 interface below obtains explicit confirmation; the server still rechecks every condition. List rendering, navigation, refresh and timeout never submit a command.

## Atomic audit, idempotency and uncertainty

Migration0008 adds `commerce_reservation_recoveries` and an order index. A two-statement D1 batch inserts the immutable command and recovery audit. The audit trigger rechecks current eligibility, expected version, server time and line bounds, then inserts the existing `expire` transition;0006 and the stock triggers check again and release the stored lines. Any failure rolls back command, audit, transition, every stock movement and order update together. Ordinary customer cancellation and the existing expiry engine are unchanged.

The audit contains command/order references, reviewed version, server timestamp, fixed reason and a SHA-256 digest of the trusted operator email/sub under a versioned actor scheme. It stores no raw email/sub, snapshot, customer details or cookie. **This is pseudonymous attribution, not anonymous data.** An authorized developer can derive a digest from the approved identity configuration for incident investigation; access/retention/identity-change procedures need review before production. UI exposure of raw identity or actor hashes is not enabled.

The command key is `recovery-{requestId}`; a canonical hash binds the operation, actor and all confirmed fields independently of object property order. An identical replay returns the original durable receipt without releasing twice. Reusing the key for another actor, order or reviewed version returns409. A cancelled record without that exact receipt is not reported as this command's success. A recovery/ordinary-expiry race creates at most one release; the losing recovery receives conflict. Before rejecting a changed order state, both preflight and failed-batch reconciliation recheck durable receipt: an identical request may have committed between the preceding receipt lookup and order read. Those two interleavings have deterministic regression tests; a successful replay is not mislabeled as a conflict.

A successful receipt contains only `testOnly`, request/reference, expected/resulting version, first recorded time and replay flag. It proves that this specific test command was recorded, **not** the current order/payment state or financial reconciliation. Subsequent review is a separate read. No customer capability or actor digest is returned.

After a lost batch response the service checks durable audit. If it cannot establish a receipt,503 says to retain the same request ID and details and investigate/retry that same request; never generate a replacement ID or force release. A conflict requires fresh review. A developer investigates uncertain storage outcomes, stale/conflicting commands or stock discrepancies. The owner must not resolve payment/held cases through this endpoint; those need separately designed reconciliation/operational handling.

## Acceptance, rollout and rollback

Automated coverage includes a real temporary D1 upgrade from0007 with an existing reservation, unchanged legacy records, own-line release with Facebook/other-owner preservation, immutable audit, identical/different simultaneous requests, canonical replay and actor/payload conflict, ordinary expiry winning a race, all payment/held/version/future-deadline races, nonexistent/stale/cancelled records, later-line stock failure rolling back the entire operation, lost response and lost audit read, and pre-storage validation. Worker→real React Router tests cover unapproved/absent/service identity, `.data` authorization, direct route denial, local/Origin gates, POST-only behavior, strict form/size, approved minimal receipt, generic conflict/outage and no-store.

Run the full repository validation before completion and record actual results in the execution log/PR. These tests are not provider Sandbox or owner browser acceptance. The merged command PR changed no UI; its old presentation evidence does not cover the separate L01 confirmation. L01 automated and layout evidence is recorded separately below. Actual authorized browser, screen reader, real iPhone Safari/UAT and Stripe/PayPal/payment-reconciliation gates remain outstanding.

Roll out only as reviewed local code against isolated fixtures. If migration0008 is absent, recovery fails closed; do not fall back to unaudited release. Stop by disabling local commerce or removing/reverting this command route/service. Retain0008 audit/index/triggers,0006/0007, commands, orders and stock history; earlier code can ignore the added table. A committed release cannot be undone by reverting code: do not delete audit, edit balances or recreate the original reservation as rollback. Any genuine corrective stock/order action needs its own reviewed command.

## L01: explicit operator confirmation and original receipt lookup

Only an exact eligible detail offers the action. The operator sees the full order reference, reviewed version, deadline and consequences, types the exact reference, and explicitly confirms cancellation/release. A list, held order, started/failed/unknown payment, future deadline or invalid line count cannot start it. No forced release, refund or customer-session reassignment is provided.

Before the first POST, the browser generates one UUIDv4 and saves the five confirmed fields in this tab's sessionStorage, under `velaform-local-admin-recovery-v1:{reference}`. No customer data, identity or credentials are stored. Storage failure blocks a new command; malformed saved data is retained for developer inspection rather than overwritten. Hydration loads saved context before offering a fresh action. Double clicks share one request; the 15-second transport/body timeout does not imply rollback. Reload/remount restores the original fields as uncertain, without automatic POST or query. Keep the tab open while unresolved; closing it can lose this convenience context, but does not undo the durable command/audit.

An uncertain result offers two separate actions: **Query original request (read only)** and **Retry the same confirmed request**. An explicit retry retains the original UUID, version and actor-bound fields even if a refreshed order now appears cancelled; the server can return its original receipt. A missing receipt is only the current read's observation, not failure proof. A receipt proves that command was recorded, not current order or payment state; Refresh results is a separate read. A later query outage retains a known receipt. A conflict/auth/input/not-found response stops blind retries and preserves context for developer investigation; no new UUID/version or force-release shortcut is offered. The owner refreshes and contacts the developer for these exceptions.

`GET /admin/commerce/review?reference=…&requestId=…&expectedVersion=…` adds an optional exact receipt lookup to the existing detail response. The latter two parameters must be paired, canonical and nonduplicate; they cannot be combined with pagination/list queries. The trusted approved identity and fixed reason/confirmation reconstruct the original hash. The lookup uses SELECT only and never calls the recovery command. `recoveryLookup.state` is `recorded` (original minimal receipt), `not_recorded`, `conflict` or `unavailable`. Ordinary viewing remains unchanged. Missing migration0008 makes detailed review fail closed with generic503; a lookup-only read outage returns `unavailable`. Both routes retain approved-human, explicit loopback and no-store/noindex gates.

Recent changes distinguish **Operator confirmed expired unpaid reservation** from ordinary expiry/cancellation, showing only server time, fixed reason in business language and version change. Actor/command hashes, identities and customer snapshots remain unselected. No migration is needed:0008 already contains the immutable receipt/audit facts.

Presentation fixtures cover eligible confirmation and recorded audit. They have no connected recovery/query endpoint and cannot verify a real command, identity or D1 write. Automated UI cases cover exact confirmation, duplicate submit, storage failure, remount, lost/late responses, timeout, original-key retry after cancellation, conflict, mismatched receipts and retained success during query outage. Real-D1 and Worker/Router cases cover immutable read results, actor/payload binding, strict query validation and unchanged authorization. Actual authorized browser, VoiceOver/iPhone Safari and owner UAT remain explicit #44 gates; the local runner still supplies no Access identity or bypass.

Stop this slice by disabling local mode or reverting the UI/read-query additions; retain the merged command, migration0008, orders, stock and audit. Never erase a saved unresolved request or edit balances as rollback. After this PR's checks/review/merge, the next independent task is L02's identity/environment isolation design and local test scaffolding; payment attempts/events remain later tasks.
