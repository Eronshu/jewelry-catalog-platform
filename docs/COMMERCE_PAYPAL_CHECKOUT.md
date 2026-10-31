# Owned PayPal Sandbox checkout — Issue #81

Status: local implementation under engineering checks and independent review; not merged or provider-accepted. ADR-001 and frozen V1 remain unchanged. Default configuration is off. No actual account/API authentication, approval, capture or webhook delivery was tested.

## Visible flow and shared authority

The private fictional order offers Stripe and PayPal when each is explicitly configured. Starting either records the existing canonical attempt; the unique order lock prevents another provider from starting for that order, including after an uncertain result. Browser hiding improves the experience; server/SQL ownership and uniqueness enforce it across tabs. The existing order, attempt/work, capture facts and inventory remain authoritative. PayPal association/event/dispatch receipts are transport evidence, not a new financial ledger.

PayPal starts one hosted Sandbox approval page. Returning only reads private local status and displays a message. **Check PayPal result** makes an authorized POST; canonical APPROVED allows a separate explicit **Complete PayPal test payment** action. Approval, URL parameters and signature verification alone do not confirm the order. Only canonical matching merchant, order, attempt/create key, CAD amount and a single complete final unrefunded capture, re-read at its canonical capture endpoint, can atomically confirm the order and move reserved stock to allocated. The protected owner workspace reads the same data.

Only fixed synthetic customer profiles are stored. The test request uses `NO_SHIPPING` to avoid sending customer addresses; that is a **fictional-test assumption**, not the production delivery design, address validation or an assurance of seller protection. Real shipment/address requirements and seller protection eligibility must be separately checked against the selected PayPal product before real selling. No fee, qualification or legal conclusion is implied.

## Dispatch, events and recovery

Original create/capture keys and parameters are persisted with the actual merchant association. An acknowledged new receipt plus exact readback/current work claim is required before either mutation. Capture has a distinct immutable receipt against the current query claim after canonical approval. A lost receipt/response never authorizes repeating mutation; later calls only query. Unknown outcomes retain inventory even past the original ten-minute unpaid deadline. There is one attempt per order; no silent method switching or manual paid override.

`POST /checkout/orders/:orderId/paypal` accepts only CSRF, operation (`start`, `query`, `capture`), UUID requestId and expectedVersion. Existing private session ownership and exact Origin/CSRF are checked again before dispatch and response. Browser amounts, merchant IDs and provider references are not accepted. GET/HEAD cannot mutate.

`POST /checkout/paypal/webhook` is loopback-only, bounds raw bodies at128KiB and uses the official signature verification postback against the configured real application webhook ID. It never fetches an event-provided certificate URL. Verified deduplicated events wake canonical queries; they do not capture automatically. PayPal's mock Webhook Simulator does not support this postback method and cannot prove this acceptance path. Local forwarding/HTTPS test ingress has not been set up or authorized.

A lost create response without a verified correlated event leaves manual review: do not create again. A consumed capture receipt permits query only. Refund/reversal/denied attention events retain financial facts and allocated stock, show review required and block new paid allocation; they do not implement a refund or resolve a dispute. There is no unattended scheduler, cancellation of provider orders, owner refund workflow or automatic stock-release repair in this feature. Developer investigation handles these fictional local exceptions; production needs the later owner operations and reconciliation work.

## Safe opt-in and pauses

No credentials are required for offline development. After separate actual-test authorization, the owner creates a regular non-symlink JSON file outside this repository, readable only by that owner (`0600`), containing `merchantId`, `clientId`, `clientSecret` and optionally `webhookId`, from the same Sandbox merchant/application. Use the local editor, not a command containing secret values; do not send them in chat, screenshots, issues or Git. Configuration checks shape, not authentication or ownership. PayPal credentials have no universal test-key prefix; the adapter pins the API to Sandbox and never falls back to Live.

```sh
COMMERCE_PAYPAL_MODE=sandbox \
COMMERCE_PAYPAL_CONFIG_FILE=/absolute/private/path/paypal-sandbox.json \
npm run commerce:local
```

This selects the private file and enables local new-payment/capture flags. Stripe can be configured separately in the same runner. The generated ignored `.dev.vars` is private and removed on normal runner exit; abnormal termination requires checking/removing only this generated file locally. The source JSON remains outside Git. The runner creates a fresh temporary instance/database each time and preserves it on exit: restarting is not recovery of the previous instance/session.

For controlled recovery, disable `COMMERCE_PAYPAL_NEW_ORDERS` to stop starts and `COMMERCE_PAYPAL_CAPTURE` to stop capture, while retaining the same Sandbox config, merchant, instance, database and session for query/event verification. Full stop can close the loopback runner. Do not delete attempts, financial facts, receipts or migration0023; do not force-release attempted stock or downgrade the schema. Preserve state and use a reviewed forward repair. No production config was changed.

## Acceptance still required

Offline tests cover real temporary D1 migrations/history, owned start/approval/explicit capture, unknown results, canonical mismatches, receipt/claim races, duplicate events/allocation, cross-provider conflict, permission boundaries and UI uncertainty. These are not actual provider success. Before enabling real commerce, separately validate secure local authentication, genuine Sandbox approval/capture and canonical payloads, actual webhook delivery/retries, expired/cancelled sessions and manual recovery, iPhone Safari hosted return/cookie behavior, VoiceOver/keyboard, owner UAT, fulfillment/refunds/notifications/reconciliation and restore/monitoring. Real Google/customer address persistence and production access require their own reviewed decisions and authorization.

Official references checked2026-10-31: [Orders create](https://developer.paypal.com/api/orders/v2/orders-create), [capture](https://developer.paypal.com/api/orders/v2/orders-capture), [authentication](https://developer.paypal.com/api/rest/authentication/), [idempotency](https://developer.paypal.com/api/rest/reference/idempotency/), [webhooks and signature verification](https://developer.paypal.com/api/rest/webhooks/rest/). Platform payloads and account eligibility remain actual Sandbox gates, not assumptions promoted into business promises.
