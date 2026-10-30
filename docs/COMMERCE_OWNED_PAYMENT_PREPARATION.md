# Owned test payment preparation — Issue #75

Status: local implementation, complete engineering checks, compiled browser smoke and independent review finished on `codex/owned-stripe-preparation`, based on main `395dd1e` (#74; main CI110 passed). PR/exact-head CI and merge remain pending. Actual evidence and limitations are in the execution log.

## One order and one payment history

The local customer journey already creates an owned unpaid order. This slice lets that original browser explicitly record a Stripe **test preparation** against it and view the resulting private state. It reuses `commerce_payment_attempts` and `commerce_payment_work`. No provider client is invoked, no Session exists, no capture fact is written, and nothing becomes paid or allocated.

- `POST /checkout/orders/:orderId/prepare-payment` is a JSON resource, never a document-rendering action. GET rejects with 405 locally; ordinary/remote environments stay unavailable before business access.
- The separate `COMMERCE_CHECKOUT_PAYMENT_PREPARE=local-test` setting defaults off. The isolated runner supplies it only with `COMMERCE_LOCAL_PAYMENT_PREPARE=1` and seeds the existing fixture payment scope with its own checkout instance. It does not read merchant credentials.
- Mutation requires the original unexpired/revoked-safe guest session, exact origin, CSRF and bounded exact form fields: `csrf`, original UUID `requestId`, and `expectedVersion`. Neither amounts nor provider/account choices come from the browser.
- The service checks the owned acceptance/origin chain and immutable server snapshot, preserves its true `fictional-checkout-acceptance-v1` rule and integer CAD amount, and samples fresh time after asynchronous reads. The HTTP caller reauthorizes immediately before the commit check. An authorization failure cannot be converted into a successful or uncertain write.
- One transaction inserts the command, attempt and work and changes only `payment_state: not_started → processing`, `version + 1`. It does not change order state, commercial fields, line snapshots or stock quantities. The postcondition rejects missing trigger effects atomically.
- Same-key replay recovers the existing preparation; another key cannot create a second intent. An unknown write/readback keeps the original key/parameters. The response projects only the existing owned order, not internal operation/account/owner keys.

## Migration and simulator isolation

Migration0021 rebuilds the **same** canonical attempt table to admit the accepted owned rule alongside the historical zero-tax rule. It preserves old rows, unique constraints, child references, triggers and indexes. Historical rows are restored before insert hooks, avoiding another order lock or duplicate work. Historical migrations and saved snapshots are unchanged.

The legacy API remains limited to old lab sources. The new owned API accepts only the strict checkout origin/acceptance chain and Stripe fixture scope. A database work-claim guard prevents old fixture execution from processing an owned attempt. A preparation record is not permission to run the historical simulator or fabricate a payment fact. Actual history upgrade, foreign-key integrity and migration failure rollback require real temporary D1 tests.

## Inventory, recovery and responsibility

Any attempt blocks ordinary unpaid cancellation and expiry, including after the old ten-minute deadline. This conservatively protects stock until a future provider-aware outcome can authorize a change. The page explicitly states that no provider request was sent; it never promises automatic release or completed payment. Unknown preparation blocks the competing cancel action and offers the same-key retry and read-only refresh. Cart selection remains intact.

The developer handles unknown preparation, unavailable storage and migration failures in these fictional local tests. There is no owner-facing recovery permission or production workflow in this slice. Disable **new preparation** while preserving reads/history; stop the loopback runner if needed. Preserve temporary state rather than drop tables, delete attempts, reset stock or run a destructive migration downgrade. A reviewed forward repair must retain audit history.

## Required verification and next boundary

Verify owned taxed amounts, same-key/lost-response recovery, competing keys/cancel/expiry, fresh-clock expiry, late session revocation, wrong owner/scope/CSRF/origin, client-field injection, missing trigger effects and legacy isolation. Verify historical payment dependencies survive0021 and a failed migration rolls back. Check private JSON routing, default-off deployment, double-click/unknown-result UI, keyboard error focus, mobile layout, format/lint/generated types and production build. Independent payment/inventory/permission review and exact-head CI remain merge gates.

The next slice connects the existing Stripe adapter to this same authority: durable original Session parameters and association, dispatch uncertainty/query recovery, hosted redirect/return, signed-event deduplication and canonical account/order/amount/currency/payment checks before atomically allocating stock. Returning to the site is not evidence of payment. Stripe's Session lifetime differs from the local reservation; dispatch must protect stock first and never blindly expire it. See the [adapter contract and official references](./COMMERCE_STRIPE_SANDBOX_ADAPTER.md).

Actual provider Sandbox payments, real customer data, iPhone Safari/VoiceOver, business UAT, PayPal integration and production rollout are still unverified. Account screenshots establish available test dashboards only. Secure local credential entry and explicit actual-test authorization precede provider calls; no keys/passwords/cards belong in chat or Git.
