# Commerce local development boundary

Status (2026-10-21): C09b2 / #38 merged in PR #39. The isolated product-detail → cart → delivery → test quote flow is available locally. Issue #37 adds an optional Google Places adapter; its local code/tests are prepared, but real Google integration and iPhone Safari acceptance remain unverified. The separate developer lab still exercises unpaid reservations. Neither flow is connected to provider payment or approved for deployment. [The PR sequence](./COMMERCE_PR_SEQUENCE.md) governs integration; [the implementation plan](./ONLINE_SALES_IMPLEMENTATION_PLAN.md) retains later gates.

## Availability policy

`app/lib/commerce/environment.server.ts` exports `isLocalCommerceEnabled(request, env)` and `requireLocalCommerce(request, env)`. Commerce is disabled unless the supplied server environment has its own `COMMERCE_MODE` property equal to `local-test` and the parsed request URL uses HTTP with hostname `localhost` or `127.0.0.1`. Any port is allowed. HTTPS, IPv6, LAN addresses, remote preview hosts, unknown modes and `live` are rejected. There is no live-mode implementation.

When a request supplies an `Origin` header, it must exactly match the request origin, including the port. A missing Origin is permitted for ordinary navigation and server requests. This is an availability check, **not authentication or complete CSRF protection**: each mutation must still validate its method, same-origin submission and input; Admin actions must still require the existing trusted principal. `Host` and forwarded headers cannot enable a remote request. A developer must not proxy a public service to this local origin and treat the gate as an access control.

`requireLocalCommerce` throws a generic 404 with `private, no-store` when unavailable. Call it before reading commerce data or performing side effects in future route loaders/actions. The `/commerce-lab` loader and action call the gate before storage access. Mutations additionally require an exact Origin, a browser session and bounded form input. No public storefront navigation points to this route.

## Test configuration and data

Unit tests explicitly inject `{ COMMERCE_MODE: "local-test" }`; this is a **test assumption**, not a merchant setting or customer promise. The module does not load `.env` files, read credentials, create external clients or choose a database. No configuration has been added to the Worker deployment file. The local runner below supplies explicit isolated bindings; the normal deployment configuration remains disabled.

- Use temporary/local D1 and R2 state with fictional products and customers only. A local URL does not prove that a binding is local; verify bindings independently before any commerce write.
- Do not reuse production database IDs, customer exports, mail recipients or live credentials. Do not put secrets in fixtures, CI configuration, commits or chat.
- Remote Sandbox testing needs a separately reviewed environment policy, isolated bindings and provider verification. Do not loosen this gate just to make a remote callback work.
- CI runs unit/integration tests and `payment:spike:test` without provider credentials. The prototype tests mock provider HTTP; they are not Stripe or PayPal Sandbox end-to-end evidence. Preserve the format, lint, typecheck and build checks.
- Local browser smoke verification is separate from provider Sandbox, real iPhone Safari, accessibility audit and merchant UAT; those remain acceptance gates.

## Local validation and stopping

Run `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run payment:spike:test` and `npm run build`. The environment tests cover missing/wrong mode, remote origins, cross-origin headers, spoofed proxy headers and fail-closed behavior, without any network calls.

Remove the local test setting to disable availability; revert this foundation if needed without changing database state. Once payment attempts exist, a broader stop-sales mechanism must preserve callbacks, reconciliation and existing-order servicing: this local gate is not that operational switch.

## Run the fictional shopping preview

```sh
npm run build
npm run commerce:local
```

Open `http://127.0.0.1:8791/products/fictional-0`, select a colour, add items, then follow **View cart** to `/cart`. The runner creates a new OS temporary directory on every invocation, applies migrations **locally**, seeds three fictional necklace styles with three colours each, and serves the compiled Worker on loopback only. Gold-tone has 5 physical units with 1 reserved for Facebook (4 website units); silver has 5 website units; black is out of stock. Generated fixture illustrations use local R2 and the normal validated image route; they are not merchant photographs.

If the port is occupied, preserve the existing process and run `COMMERCE_LOCAL_PORT=8792 npm run commerce:local`. The override accepts ports 1024–65535 and keeps the loopback binding. Stop/restart your own runner after rebuilding assets.

The customer cart saves only variant IDs and integer quantities under `velaform-shopping-preview-cart-v1`; it does not reuse the lab's browser storage. Reload/back-navigation restores selections; unavailable storage falls back to the current visit with a warning. Use the left and right quantity arrows to decrease or increase an item; the increase arrow stops at the currently available stock or 20. The server resolves exact IDs, current variant prices and website availability; client-supplied prices or extra fields are discarded. Hidden/deleted products do not leak metadata and make the subtotal unavailable. Inactive or insufficient-stock lines require correction. Fetch failures/stale responses cannot supply a current subtotal; use **Refresh prices and availability** to retry.

This is an item subtotal, not a final quote: no delivery, tax, address, customer identity, reservation or order is created by `/cart`. Cart reads do not reduce inventory. Two tabs do not currently synchronize changes. Local-only purchase controls appear on the existing product route; the default public site has no purchase controls and `/cart` is unavailable.

The temporary Wrangler configuration has no remote IDs or preview configuration. The child environment uses an allowlist without inherited API credentials, disables repository dotenv loading and telemetry, and uses temporary config/state paths. The runner does not modify repository bindings or read merchant accounts. The only optional credential bridge is an explicitly selected, separate Google browser test key file, described below. Do not expose the port through a public proxy. Do not reuse this test configuration for Sandbox callbacks or deployment.

### Separate developer lab

Open `/commerce-lab` explicitly. It remains an internal quote/reservation harness, not the future customer checkout page. Add items, request a server quote, reserve, refresh to recover the same browser session's recent orders, then cancel to release stock. Prices, shipping fees and zero tax are fictional. No payment button or provider is connected. Orders are unpaid test records; stock is held atomically and cancellations release only the order's own lines.

The internal expiry command is tested, but **no automatic expiry job runs yet**. The page says so: cancel unpaid reservations manually. Only the latest 20 session orders are listed; session cookie loss prevents accessing previous reservations through this UI. The next runner invocation starts a separate fresh test database. Production cleanup, recovery and order search are not implemented by this prototype.

Stop with Ctrl-C. The printed temporary state directory is preserved for investigation; the runner never deletes existing state. The OS may eventually remove temporary files. The normal site, without `COMMERCE_MODE=local-test`, responds 404 at this route. Rollback is stopping the local runner or disabling its mode; do not drop production tables or rewrite inventory history.

## C09b1: transient delivery quote resource (merged in PR #36)

`POST /checkout/quote` is gated by the same explicit loopback mode and exact Origin. Send an URL-encoded form with one `checkout` JSON field (8 KiB body limit); GET returns 405 locally, normal/remote environments return 404 before data access. Contract version is `local-checkout-v1`. Input includes a UUID v4 `requestId`, `lines` (variant IDs and quantities), `contact` (`name`, `email`), and `delivery` (`method`, plus `address` for local delivery/shipping). Address fields: `line1`, optional `line2`, `city`, two-letter `province`, `postalCode`, `country: CA`. Pickup discards incidental addresses. Only use fictional identity/address fixtures. Syntax validation does not verify an address or postal/province match.

The explicit **fictional-delivery-v1** fixture charges pickup 0 cents, local delivery 500 cents (ON + K1A prefix only), and Canadian shipping 1500 cents. A deliberately fictional **10% tax on items + delivery**, rounded half-up to cents with integer arithmetic, tests nonzero tax handling. These values/coverage are **not merchant rates, tax advice, free-pickup promises or delivery estimates**. Missing/malformed selected-method rules refuse quotes. This is separate from the developer lab's historical zero-tax fixture; lab/order snapshots remain unchanged.

The server rereads exact variant IDs, current prices/versions and website stock (excluding Facebook/checkout/allocated amounts), refusing unknown/inactive/hidden/out-of-stock lines. It returns a `testOnly` CAD quote with contract/rule versions, request correlation, line amounts, subtotal, shipping, tax base/rate/tax, total and a 10-minute expiry. It does not echo contact/address, create cookies, persist quotes, reserve stock, create orders or invoke providers. Errors contain field paths or generic descriptions, never submitted values/DB exception details. Responses are no-store/noindex.

`requestId` only helps a future form ignore stale responses; it is not a quote ID or authorization. The **separate C09b2 form** must invalidate quotes on any form/cart change, reject mismatched/expired responses, show a permanent test notice, focus field errors and require review after changed amounts. C09c will need server-side order/detail/amount binding and fresh inventory validation; this transient response cannot be submitted to the lab's reservation flow. C09b1 itself added no checkout page/link; the separate C09b2 slice below supplies these locally. Rollback is reverting the resource/modules or stopping local mode; no schema/data rollback is needed. Provider E2E, owner UAT, mobile Safari form and accessibility acceptance remain unverified.

## C09b2: delivery form and quote review

From a valid, freshly resolved `/cart`, choose **Review delivery (local test)** to open `/checkout`. Direct local navigation is allowed; an empty cart cannot request quotes. Pickup collects only name/email; local delivery and shipping show Canadian street, optional apartment/unit, city, province/territory and postal-code fields. Use fictional details only, for example `Fictional Customer`, `fictional@example.invalid`, `100 Fictional Test Street`, `Test City`, `ON`, `K1A 0B1`. The example is not a verified delivery destination. Standard autocomplete attributes and 16px form text support native browser filling/mobile input; actual iPhone Safari remains an acceptance gate.

**Get test quote** sends normalized details via POST to the C09b1 resource. Pickup omits any previously typed mailing address. Field errors focus an error summary with links back to inputs; correct fields stay in component memory on recoverable errors. No contact/address is saved in localStorage/sessionStorage, route URLs, cookies or the database. Leaving the page discards its form state; item selections remain separately in the cart. No customer account/address book is created.

Every form/cart change, retry, failure or expired quote clears the prior review/confirmation; changing and reverting values cannot restore an old quote. Attempts have new UUIDs and cancellation; late results are ignored even if transport cancellation fails. Duplicate in-flight submissions are blocked. A hanging request times out after 15 test seconds and allows retry. Quote expiry is checked by a timer and focus/visibility refresh, including a page returning after suspension. A returned non-test, wrong-contract, mismatched-ID/lines or expired response cannot become a reviewable quote.

The summary shows current items, test delivery/tax and CAD total. The checkbox only acknowledges reviewing fictional charges; it creates no order, stock hold or payment and does not submit an acceptance token to the server. C09c must still bind a new quote/details snapshot to an owned order and revalidate stock before provider payment.

PR #39 merged as `6f42d36`; the Google adapter below is a separate slice. Rollback removes the local cart link and checkout route/component, or stops local mode; the existing cart/lab and history remain usable. No schema downgrade is needed.

## Optional Google Places local test / #37

Default runs do not read a Google key or load its script. A separately restricted browser test key can be enabled through the explicit mode/key-file bridge in [Google Places local setup](./GOOGLE_PLACES_LOCAL_SETUP.md), after the owner authorizes the provider project and billing. This work does not create/configure an account or activate billing. No server/payment key belongs in this bridge. Browser keys are visible in page data and requests by design; restrictions are required.

For local delivery/shipping, the visitor can choose **Search address with Google**, with a notice that search text goes to Google. Only that action loads the SDK. Pickup does not show it. Canadian suggestions feed editable address components into the existing form; missing required fields still block quotes. Existing apartment/unit text is preserved and must be reviewed. Suggestions do not verify delivery eligibility. Searching/selecting invalidates old quotes and confirmations; late results cannot overwrite newer edits, cart changes or delivery-mode changes. Timeouts, missing/denied configuration and provider failures leave manual entry available. No map or location permission is requested.

The application requests only `addressComponents` and does not persist raw responses, place IDs, coordinates or search history. Address/contact state remains transient; normal POST quote validation and server amount calculation remain authoritative. This does not approve retaining Google-derived address data in future orders; provider storage/attribution/privacy requirements must be checked before that work.

Local automated tests use a stub widget and intercept script insertion: they are **not real Google acceptance**. The runner was smoke-tested with a generated dummy key, without clicking the Google button: private temporary `.dev.vars` mode 0600, Wrangler key output hidden, zero Google scripts before opt-in, and manual shipping quote still usable. Real key restrictions, provider results/errors/attribution, pricing, accessibility and iPhone Safari remain unverified. Disable by stopping the runner and restarting without both Google environment settings; no data/schema rollback is needed.
