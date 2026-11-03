# Inspected test returns and separate stock restoration (Issue #97)

This default-off, loopback-only Admin feature uses fictional goods and explicit test assumptions. It does not set a customer return policy, issue money, contact a customer or dispose of goods.

## Owner workflow

From an order choose **Return inspection and stock**. Only an original whole-order handoff recorded by the existing packing/handoff flow is eligible. The owner checks every original item and explicitly records either **sellable received** or **unsuitable received**. Inspection records an immutable receipt and changes no stock. Unsuitable goods remain outside sellable stock; there is no reclassification or disposal action.

Reload after a confirmed inspection. A separate whole-order restock action is available only for sellable goods and a recorded, verified full refund associated with that same original capture. It restores the original handed-off quantities once, through the existing stock command and `return` movements. Physical stock increases; Facebook reserve, checkout reserve and allocated stock do not change. Original payment, capture, refund and handoff history remain intact. Inspection may precede refund confirmation; it never initiates a refund.

An unhanded refunded order is deliberately ineligible. Its allocation still protects goods already physically present. Applying a physical return would count those goods twice. A separate safe allocation-release feature is still required. The two existing actual Sandbox payment/refund test orders were unhanded and were not used or altered for this feature.

## Configuration and access

`COMMERCE_LOCAL_RETURNS=1 npm run commerce:local` prepares a new isolated fictional database and the existing local payment scope, without reading provider credentials. It supplies `COMMERCE_OWNER_RETURN_UI=local-test` and `COMMERCE_OWNER_RETURN_WRITES=local-test`. It supplies no Admin authentication bypass, paid fixture or completed handoff. Approved Admin authentication, the same instance and canonical historical order facts are required.

The detail page is GET-only. Mutations use its separate `/commands` JSON resource and same-origin POSTs. The server selects original quantities, associations and inventory snapshots; the form cannot supply quantities or balances. An atomic SQL command checks all original lines, order version and all four current inventory balances, then verifies complete effects. Additive migration 0028 preserves all previous financial and inventory structures and guards.

## Lost responses, pause and recovery

Before a request, the browser saves the original UUID, operation, version and stock hash in session storage. A lost response remains uncertain: do not create a replacement request or assume failure. Reloading preserves the original request for an explicit local receipt lookup. A `not_recorded` lookup does not prove a failed write and does not unlock a replacement action. Recorded receipts are matched to the exact original input before clearing browser state. Cross-device Admin history is read-only; lookup cannot impersonate another actor.

Pause new actions by removing only `COMMERCE_OWNER_RETURN_WRITES`, retaining the UI, scope, database and approved access for lookup/history. A stock change requires a fresh page and deliberate new action after resolving the old request. Do not edit receipts, rewind a database, lower migrations or manually change inventory to undo a command. Revert/disable the interface to stop new operations while preserving committed history.

## Acceptance boundaries

Real temporary D1 tests cover populated 0027→0028 preservation and failed-migration rollback; Stripe and PayPal original histories; inspection without stock change; later refund; unsuitable/unhanded/pending cases; same-key recovery, cross-key duplicates, stock races, forged associations and silently ignored writes rolling back atomically. HTTP and actual Worker/Router boundary checks cover Admin, instance, Origin, default-off/write pause and final authorization. Separate component tests cover confirmation, storage and uncertain receipt handling.

The `/owner-return-preview` Admin shell scene uses paused fictional props, not authentication or a database. Responsive preview and automated tests are not actual iPhone Safari, VoiceOver, business-owner UAT or production acceptance. Partial returns/refunds, unhanded allocation release, policy decisions, real goods, customer communications and launch authorization remain separate tasks.
