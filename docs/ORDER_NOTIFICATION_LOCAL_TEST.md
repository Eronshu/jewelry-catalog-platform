# Local order notifications and private status links

Issue #105 adds a visible, fictional inbox to each local Admin order. It does not send email, SMS or provider requests. Mail provider, sender identity/domain, recipient policy, approved customer wording, production abuse protection and real delivery acceptance remain separate launch work.

## Use

After a production build, start `COMMERCE_LOCAL_NOTIFICATIONS=1 npm run commerce:local`. The default is off; any other opt-in value is rejected. Each invocation creates a new fictional database and instance, as before. Existing Admin authentication is still required; the notification flag never grants Admin access.

Open an order from `/admin/commerce/orders`, then **Test notifications and private status links**. **Prepare next test notification batch** records missing verified payment, refund, packing and handoff events, at most 100 per command. Reload before another batch or action. Historical events are backfilled explicitly; there is no unattended notification worker or transactional email transport in this slice.

Recipients come only from the original accepted fictional checkout profile: `ontario@example.invalid` or `bc@example.invalid`. Forms cannot choose an address, amount, event source or provider. A provider redirect, approval, unsigned/unverified observation or mutation acknowledgement does not create a payment/refund success notification. Packing/handoff notifications describe recorded operations; handoff is not proof of arrival.

**Simulate delivery failure** records a fictional failure. **Simulate delivery** records a fictional delivery to the local inbox, never an actual email. A notification has at most three attempts; a delivered or revoked record is terminal. There is no automatic retry. Every action persists the original browser request UUID and input before POST. After uncertainty, **Check original receipt** and **Retry original request** use that same identity; receipt lookup remains available with new writes paused. A malformed saved request is preserved and blocks replacement. Successful actions require a canonical reload before another action.

## Private status

**Copy private test status link** is available only in the protected Admin view. The raw bearer is not rendered as a hyperlink, text input or visible text, and is not stored in browser recovery storage. Copying intentionally puts it on the local clipboard; use only for the intended fictional recipient.

The URL is `/checkout/status#<capability>`. Its fragment is not sent in HTTP request addresses. After hydration the page removes the fragment from the current history entry and waits for **Show my test order status**, then submits the capability in a same-origin POST body. There are no token query parameters, email/order search, ownership cookies, payment, cancellation or Admin permissions. The page shows only order reference, current order/payment/fulfillment/delivery state, total and verified refund amount.

Capabilities expire 24 hours after preparation. **Revoke private status link** invalidates one immediately. They bind to the original mode, instance, order, notification and prepared canonical origin; a copied database reconfigured to another origin does not resolve the old capability. Only SHA-256 capability hashes are stored in D1. The server derives the original bearer with a domain-separated HMAC from the private local key. Changed keys fail closed for reconstruction. Private pages/resources use `private, no-store`, `no-referrer`, `noindex` and static error messages; invalid, expired and revoked links receive the same denial.

## Local key and recovery

The runner generates a 32-byte random key without using payment credentials. It writes `notification-link-key.json` and temporary `.dev.vars` with mode0600 in the new state directory outside the repository. `.dev.vars` is removed on normal shutdown; the private key file is retained with the state so an intentional same-state manual recovery can preserve reconstruction. Do not print, upload or commit either key or bearer. Existing local runner invocations still make a fresh database, not automatic resume.

The independent controls are `COMMERCE_OWNER_NOTIFICATIONS_UI=local-test`, `COMMERCE_OWNER_NOTIFICATIONS_WRITES=local-test`, `COMMERCE_ORDER_STATUS_LINKS=local-test` and private `COMMERCE_NOTIFICATION_LINK_SECRET=<64 lower-case hex>`, together with existing loopback checkout mode/instance/origin configuration. Never expose Admin or the whole local site through a tunnel for this test.

## Data and checks

Migration0031 adds notification commands, intents, simulation attempts and revocations plus guarded canonical source views. It does not update order, capture, refund, fulfillment, stock command or movement facts. Unique event sources, original actor/input hashes, immutable receipts, exact materialization counts and SQL aborts protect retries, concurrent commands and ignored child writes. Confirmed partial refunds each contribute one event regardless of repeated canonical observations. A batch failure cannot partially prepare notifications.

Real D1 coverage includes filled0030 forward migration, rowids/full financial-history preservation, failure rollback, same-key/competing preparation, bounded retry, acknowledgement uncertainty, ignored writes, wrong recipients/origins, capability tamper/expiry/revocation and protected HTTP to read-only status. Worker→Router tests exercise synthetic signed human JWT gates and JSON resources; UI tests exercise persisted request recovery and fragment handling. Presentation checks do not establish deployed Access, actual email, Safari, VoiceOver or business-owner UAT.
