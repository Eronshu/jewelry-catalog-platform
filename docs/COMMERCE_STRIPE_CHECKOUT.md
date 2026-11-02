# Owned Stripe Sandbox checkout — Issue #79

**Merged in PR #80: exact head CI115, independent review and main CI116 passed (`a3a7731`).** This is an isolated local-test feature, not a live checkout or completed provider acceptance. It extends ADR-001 without changing frozen V1. The existing owned order, payment attempt/work, capture-fact table and stock ledger remain the authorities; provider Session associations and event receipts contain transport evidence, not a second payment balance.

## Customer and owner flow

An explicitly configured local runner offers Stripe on a private fictional order. Starting first records the existing owned payment attempt, then binds its original amount, create key, account, origin and fixed Session expiry before a durable one-time dispatch. The customer continues to the same Stripe-hosted test page. Returning to the private order only displays status; **Check payment result** makes an authorized POST to query Stripe. The return query string never changes payment state.

Canonical verification reads the account, Session, PaymentIntent and latest Charge. Only matching local instance/order/attempt/create key, CAD total, test mode and full captured, unrefunded and undisputed funds may create a canonical capture fact and atomically confirm the order and move its reserved items to allocated stock. The owner workbench reads that same order and inventory. No card fields, client secret or raw provider payload enter this application’s pages or database. A point-in-time check does not replace later refund/dispute reconciliation.

The original ten-minute unpaid deadline is not the Stripe deadline. Any attempt already blocks ordinary cancellation/expiry; the Session parameters use a fixed sixty-minute test expiry. Provider uncertainty never releases stock. This duration is a test design choice, not an advertised delivery or customer policy.

## Interfaces and conservative recovery

- `POST /checkout/orders/:orderId/stripe`: exact `csrf`, `operation` (`start` or `query`), UUID `requestId`, and `expectedVersion`. The original browser capability, exact Origin and CSRF authorize access. Amounts, account and provider object IDs are not browser inputs. GET is read-only/405.
- `GET /checkout/orders/:orderId`: private local projection only, no provider request or implicit confirmation. Guest cookies already use Lax for top-level hosted-payment returns; real Safari/other-browser behavior still requires acceptance.
- `POST /checkout/stripe/webhook`: loopback-only raw bounded body and Stripe signature validation. This is for an explicitly authorized future CLI-forwarding test, not a deployed public endpoint. Signed events are correlated wakeups; canonical provider reads still decide the result. Replays must not duplicate stock allocation or lose pending reconciliation.

Dispatch uncertainty retains the original request parameters and never sends a second CREATE. A known Session can be queried; a lost Session ID needs a verified correlated event plus a canonical read. Missing, expired, conflicting or unverifiable results retain stock and show review required. There is no automatic new attempt, provider cancellation, refund or manual paid override. Operator recovery/release after verified nonpayment remains separate work. A local test can therefore remain held; do not describe this as a complete unattended recovery system.

## Safe configuration — no credentials needed to develop

Default `npm run commerce:local` stays offline from Stripe. `COMMERCE_LOCAL_PAYMENT_PREPARE=1` still enables preparation only and sends no provider request.

Actual provider testing is a separate user-authorized step. Prepare an owner-created JSON file **outside the repository**, with file permissions `0600`, regular file rather than symlink, containing `accountId`, `testSecretKey` and optionally `signingSecret`. Values must come from the same Sandbox. Do not paste values into chat, a terminal command, screenshots, issue/PR text or Git. No live key is accepted. Configuration validates format only; it is not proof of account ownership or successful authentication.

After explicit authorization and local safe setup, the runner interface is:

```sh
COMMERCE_STRIPE_MODE=sandbox \
COMMERCE_STRIPE_CONFIG_FILE=/absolute/private/path/stripe-sandbox.json \
npm run commerce:local
```

That command enables provider calls **when the tester uses the payment/query controls**. Do not run it with real credentials as part of offline validation. The runner does not read `STRIPE_SECRET_KEY`, repository dotenv or inherited provider credentials. It writes only its own temporary `.dev.vars` with mode `0600` and removes that generated private file when its server exits normally; a hard crash can leave it, so protect/remove the printed temporary directory’s private file locally. It preserves the fictional database for investigation; each ordinary invocation creates a new database and instance, not a demonstrated restart recovery path.

Server bindings are `COMMERCE_STRIPE_SANDBOX=local-test`, `COMMERCE_STRIPE_NEW_SESSIONS=local-test`, `COMMERCE_STRIPE_ACCOUNT_ID`, `COMMERCE_STRIPE_TEST_SECRET`, and optional `COMMERCE_STRIPE_SIGNING_SECRET`. These are never browser loader configuration. To stop new payments, remove only the new-Sessions flag in a controlled existing runtime; retain provider configuration/status/query and all transaction evidence. Stopping the runner is not rollback of an in-flight provider operation. The standard fresh-instance runner is not the production stop-switch/restart mechanism.

## Verification and rollout gates

### 2026-11-02: first actual Sandbox attempt and Worker transport repair (#85)

The user configured a private external test file and explicitly authorized actual
Sandbox tests. Read-only authentication passed, including the configured account,
Canada and CAD checks. `charges_enabled=false` and an inactive card capability
were observed; this does not establish the cause of a failed Sandbox payment or
authorize activating a live account.

The compiled local journey reached a private fictional CAD44 shipping order.
Its first Stripe start retained one stock reservation but produced no hosted
link. A bounded canonical read found no matching Session. A real workerd
regression then reproduced that `redirect: "error"` throws before outbound
transport; Node HTTP fixtures had missed this runtime difference. The adapter now
uses `manual` and still rejects every non-2xx or redirected response without
following it. See [Cloudflare's Request contract](https://developers.cloudflare.com/workers/runtime-apis/request/).

The first attempt and its protected inventory remain preserved; it was not
replayed, cancelled or declared paid. No card was submitted. Successful hosted
payment, decline/cancellation, canonical allocation and genuine event delivery
remain unverified. A second independent instance using the repaired Worker reached
a fictional CAD99 multi-item shipping order, but again produced no hosted link.
A bounded canonical list returned no matching Session. The cause of this second
failure is not established; its one dispatch, original key and three protected
items are preserved, with no capture fact or allocation. The runner was stopped
normally and the pre-existing cart restored; neither attempt was replayed.

Offline adapter tests, real temporary D1 migration/concurrency tests, HTTP authorization/resource tests, UI duplicate/unknown/return tests, lint, generated typecheck, production build, exact-head CI and completed independent financial/stock/permission review are required for this PR. Evidence is recorded in the execution log only after it actually passes.

Safe local credentials and explicit fictional Sandbox authorization are now present.
Still required separately: actual Sandbox success, decline/authentication, cancellation, missing-return, signed-event and late-event recovery; provider account/amount comparison; iPhone Safari and VoiceOver; owner UAT; persistent background reconciliation/monitoring/restart recovery; refunds/disputes/notifications; real business/tax/privacy rules; distinct nonproduction/production resources and explicit release authorization. HTTP fixtures do not check any of those boxes. No live payments, merchant-account operations or deployment are authorized by this document.

Official API references checked during implementation: [Session create](https://docs.stripe.com/api/checkout/sessions/create), [Session retrieve](https://docs.stripe.com/api/checkout/sessions/retrieve), [metadata propagation](https://docs.stripe.com/metadata), [PaymentIntent](https://docs.stripe.com/api/payment_intents/object), [Charge](https://docs.stripe.com/api/charges/object), [idempotent requests](https://docs.stripe.com/api/idempotent_requests). Current code pins its API version; capabilities must still be confirmed in the actual Sandbox. No fees, legal conclusions or provider qualification guarantees are asserted here.

## 2026-11-02 Endive request compatibility and actual Sandbox success (Issue #89)

Safe local transport tracing isolated the second failure: canonical account GET
returned 200; Session CREATE returned 400 / invalid_request_error with parameter
payment_method_types. Read-only Sandbox payment-method configuration returned
card available/on. Stripe's [official error guide](https://support.stripe.com/questions/fix-the-payment-method-types-error)
confirms the request field was removed from 2026-09-30.endive onward. Our pinned
2026-10-28.endive therefore requires the documented
[allowed_payment_method_types](https://docs.stripe.com/api/checkout/sessions/create)
request allowlist. Response payment_method_types remains valid. No API downgrade,
Dashboard change, live activation, new credentials or unrestricted payment-method
selection is needed. CAD and explicit Adaptive Pricing off remain unchanged.

A controlled compiled-artifact-only trial replaced that single field before the
source repair: a new fictional CAD44 owned order received a real test Session
(HTTP200), opened Stripe's Sandbox hosted page and paid with the official4242 test
card and fictional contact details. Return alone left the order processing; an
explicit canonical Session/PaymentIntent/Charge query then recorded exactly one
CAD44 matching capture fact, confirmed/succeeded/ready_to_pack and inventory
checkout_reserved1→0 / allocated0→1 (on_hand5 / FB1 unchanged). Refresh did not
duplicate the fact or allocation. One CREATE and one QUERY were persisted.

The temporary trace/compiled artifact was restored exactly, the runner stopped
normally, its generated private settings removed and its original empty cart
restored. Previous failed attempts and protected stock were not replayed or
released. Only stage/status/restricted error fields were logged; no credentials,
request bodies or raw provider responses entered Git. Private recovery records
remain outside the repository.

The source repair replaces only the request field and adds a deprecated-field
regression. This evidence establishes one actual successful Sandbox card journey
for the corrected candidate, not completion of decline/3DS/cancellation, genuine
Webhook delivery, PayPal, refunds, Safari/VoiceOver, owner UAT or live readiness.
Exact-head CI and independent review still gate source integration.
