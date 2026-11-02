# Owner packing and full-order handoff — Issue #91

Status: local implementation, necessary checks and independent review completed on `codex/owner-order-fulfillment`; PR/exact-head CI and merge pending. Not a deployed service or authorization to dispatch goods. Frozen V1 remains unchanged; C follows ADR-001.

## Owner workflow and boundaries

The protected order detail links to `/admin/commerce/orders/:orderId/fulfillment` only under the isolated local UI opt-in. Existing Admin authentication and HTTP127.0.0.1 checkout scope precede all data access. Separate writes opt-in defaults off. No customer/contact data, provider credentials, raw payment keys or actor hashes are returned.

| Step                     | Required source and result                                                                                                                                        | Inventory                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Pack entire order        | Canonical confirmed/succeeded order, matching actual bound provider capture fact, no persisted payment attention; immutable packing receipt and new order version | Keep all allocation and physical stock                                          |
| Customer pickup          | Packed order with frozen `pickup`; record entire order collected                                                                                                  | One `fulfill` movement per order line; reduce physical and allocated units once |
| Local delivery completed | Packed order with frozen `local_delivery`; record entire order delivered                                                                                          | Same atomic whole-order consumption                                             |
| Hand to postal carrier   | Packed order with frozen `shipping`; record dispatch, **not customer receipt**                                                                                    | Same atomic whole-order consumption                                             |

Order, payment and fulfillment remain separate. Packing leaves canonical fulfillment `ready_to_pack` with a packing receipt; handoff sets `completed`, keeps order `confirmed` and payment `succeeded`. In this slice `completed` means the owner recorded handoff, including postal dispatch. Customer payment projections retain `paid` after handoff. It is not proof of carrier delivery or a finalized accounting period.

This local test assumes one whole-order package/handoff; no partial shipment, method/address changes, re-open/undo, postage/labels/tracking integration, notification, refund, or real carrier interaction. Real contact/address persistence remains a separate privacy/business gate. Do not put addresses, tracking numbers or customer names into request references or audit fields.

## Consistency, access and recovery

Forward migration0025 preserves all existing financial facts, cancellation/payment branches and historical simulation fences. Receipts bind scope, actor hash, original UUID, exact action/input and expected order version. Transaction guards select the original checkout origin and current paid capture authority. Wrong method, stale version, unconfirmed/unknown payment, cross-instance and persisted PayPal negative-event attention refuse new actions. Existing Stripe storage does not yet persist refund/dispute attention; complete canonical reconciliation/negative-event handling before real fulfillment is enabled. This test UI does not promise fresh external payment verification at dispatch.

Packing and handoff use existing canonical commands and stock movements, not a second stock/payment ledger. Handoff excludes only its own authorized whole-order allocation from the floor; other orders, checkout holds and FB quantities stay protected. Immutable receipt and complete movement/order readback are required; partial/ignored writes abort the transaction.

The browser stores only the original non-PII action and expected version before dispatch. Double click shares one request; timeout/remount preserves it and never automatically submits. **Check original request** works with writes paused. **Retry same request** uses the same UUID/input. An absent lookup is not proof of failure. A mismatched or uncertain response cannot clear the saved request or authorize a second handoff. After a receipt, reload latest order before the next action. If browser storage, authentication or receipt recovery fails, stop and ask the developer; the owner must not compensate by editing the database.

## Stop and rollback

Disable new actions by removing `COMMERCE_OWNER_FULFILLMENT_WRITES`; keep UI/read/lookup, Admin controls, original database and scope. UI/navigation may be disabled separately after uncertain requests have recovery support. Preserve0025 and all command/payment/stock history; never roll back balances, drop receipt tables or replace a database with an older snapshot to undo handoff. Real returns/refunds need a later separately authorized audited workflow.

## Acceptance and remaining gates

Required in this PR: actual local D1 upgrade/history preservation and all3methods, stock atomicity, replay/concurrency/stale/method/attention/scope failures, interrupted response recovery; authenticated Worker/resource-route boundary and private JSON; UI acknowledgement/double click/storage/recovery; format/lint/typecheck/tests/build and independent stock/permissions review. Results: full format/lint/generated project+fixture typecheck, 92 files/1608 application tests,6 offline payment HTTP simulations and production build passed. The final GET-error fix and both-provider paid-after-handoff assertions passed93 affected tests plus scoped format/lint/types/build and independent delta review. The 390px presentation scene had width/scroll390, one main and a44px handoff button; this is not iPhone Safari or authenticated-runtime acceptance. Exact runtime review/evidence is in the execution log.

Presentation preview is layout only. It does not count as authenticated runtime, iPhone Safari, VoiceOver, operator UAT, actual handoff, refund, notification or production verification. Stripe and PayPal each have one real Sandbox paid-order/stock success from2026-11-02; genuine webhook/negative events and exceptional payment cases are still open. No launch or live-payment authorization is implied.
