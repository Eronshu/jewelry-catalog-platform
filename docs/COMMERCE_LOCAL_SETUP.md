# Commerce local development boundary

Status: local development foundation for route C. This module does not add checkout routes, payment integration or permission to deploy. [The implementation plan](./ONLINE_SALES_IMPLEMENTATION_PLAN.md) still governs dependencies and acceptance.

## Availability policy

`app/lib/commerce/environment.server.ts` exports `isLocalCommerceEnabled(request, env)` and `requireLocalCommerce(request, env)`. Commerce is disabled unless the supplied server environment has its own `COMMERCE_MODE` property equal to `local-test` and the parsed request URL uses HTTP with hostname `localhost` or `127.0.0.1`. Any port is allowed. HTTPS, IPv6, LAN addresses, remote preview hosts, unknown modes and `live` are rejected. There is no live-mode implementation.

When a request supplies an `Origin` header, it must exactly match the request origin, including the port. A missing Origin is permitted for ordinary navigation and server requests. This is an availability check, **not authentication or complete CSRF protection**: each mutation must still validate its method, same-origin submission and input; Admin actions must still require the existing trusted principal. `Host` and forwarded headers cannot enable a remote request. A developer must not proxy a public service to this local origin and treat the gate as an access control.

`requireLocalCommerce` throws a generic 404 with `private, no-store` when unavailable. Call it before reading commerce data or performing side effects in future route loaders/actions. This change alone does not wire any route or change catalog behavior.

## Test configuration and data

Unit tests explicitly inject `{ COMMERCE_MODE: "local-test" }`; this is a **test assumption**, not a merchant setting or customer promise. The module does not load `.env` files, read credentials, create external clients or choose a database. No configuration has been added to the Worker deployment file. Future local routes require explicit local runtime configuration and separate verification of their data bindings.

- Use temporary/local D1 and R2 state with fictional products and customers only. A local URL does not prove that a binding is local; verify bindings independently before any commerce write.
- Do not reuse production database IDs, customer exports, mail recipients or live credentials. Do not put secrets in fixtures, CI configuration, commits or chat.
- Remote Sandbox testing needs a separately reviewed environment policy, isolated bindings and provider verification. Do not loosen this gate just to make a remote callback work.
- CI runs unit/integration tests and `payment:spike:test` without provider credentials. The prototype tests mock provider HTTP; they are not Stripe or PayPal Sandbox end-to-end evidence. Preserve the format, lint, typecheck and build checks.
- Browser E2E and provider Sandbox jobs remain later acceptance work once routes and isolated provider environments exist. This foundation does not claim those checks are complete.

## Local validation and stopping

Run `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run payment:spike:test` and `npm run build`. The environment tests cover missing/wrong mode, remote origins, cross-origin headers, spoofed proxy headers and fail-closed behavior, without any network calls.

Remove the local test setting to disable availability; revert this foundation if needed without changing database state. Once payment attempts exist, a broader stop-sales mechanism must preserve callbacks, reconciliation and existing-order servicing: this local gate is not that operational switch.
