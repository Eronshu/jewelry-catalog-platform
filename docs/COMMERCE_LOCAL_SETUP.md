# Commerce local development boundary

Status (2026-10-20, PR 4): C09a adds an isolated product-detail → customer cart preview. The separate developer lab still exercises server quotes and unpaid reservations. Neither is connected to provider payment or approved for deployment. [The PR sequence](./COMMERCE_PR_SEQUENCE.md) governs current integration; [the implementation plan](./ONLINE_SALES_IMPLEMENTATION_PLAN.md) retains later acceptance gates.

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

The customer cart saves only variant IDs and integer quantities under `velaform-shopping-preview-cart-v1`; it does not reuse the lab's browser storage. Reload/back-navigation restores selections; unavailable storage falls back to the current visit with a warning. Quantities apply on blur or Enter. The server resolves exact IDs, current variant prices and website availability; client-supplied prices or extra fields are discarded. Hidden/deleted products do not leak metadata and make the subtotal unavailable. Inactive or insufficient-stock lines require correction. Fetch failures/stale responses cannot supply a current subtotal; use **Refresh prices and availability** to retry.

This is an item subtotal, not a final quote: no delivery, tax, address, customer identity, reservation or order is created by `/cart`. Cart reads do not reduce inventory. Two tabs do not currently synchronize changes. Local-only purchase controls appear on the existing product route; the default public site has no purchase controls and `/cart` is unavailable.

The temporary Wrangler configuration has no remote IDs or preview configuration. The child environment uses an allowlist without inherited API credentials, disables dotenv loading and telemetry, and uses temporary config/state paths. The runner does not modify repository bindings or read merchant accounts. Do not expose the port through a public proxy. Do not reuse this test configuration for Sandbox callbacks or deployment.

### Separate developer lab

Open `/commerce-lab` explicitly. It remains an internal quote/reservation harness, not the future customer checkout page. Add items, request a server quote, reserve, refresh to recover the same browser session's recent orders, then cancel to release stock. Prices, shipping fees and zero tax are fictional. No payment button or provider is connected. Orders are unpaid test records; stock is held atomically and cancellations release only the order's own lines.

The internal expiry command is tested, but **no automatic expiry job runs yet**. The page says so: cancel unpaid reservations manually. Only the latest 20 session orders are listed; session cookie loss prevents accessing previous reservations through this UI. The next runner invocation starts a separate fresh test database. Production cleanup, recovery and order search are not implemented by this prototype.

Stop with Ctrl-C. The printed temporary state directory is preserved for investigation; the runner never deletes existing state. The OS may eventually remove temporary files. The normal site, without `COMMERCE_MODE=local-test`, responds 404 at this route. Rollback is stopping the local runner or disabling its mode; do not drop production tables or rewrite inventory history.
