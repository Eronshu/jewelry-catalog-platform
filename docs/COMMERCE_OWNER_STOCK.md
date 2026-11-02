# Owner stock receiving and Facebook allocation — Issue #83

Status: local implementation under final checks/review; not yet merged. The business remains in-stock only, with one independent Facebook unit per variant. This feature does not add backorders, purchasing ERP, full Facebook orders, payments or fulfillment.

## Owner workflow

With the explicit local stock UI enabled, inventory cards link to `/admin/commerce/inventory/:variantId`. An approved Admin can choose one action, inspect the loaded SKU/colour and quantities, acknowledge, then record it:

- **Receive inspected stock:** add only accepted units after inspection at the owner's location. Items in transit, rejected or uninspected are excluded. The1–1000 per-entry bound is a technical test limit, not a procurement or customer promise. Receiving never publishes a product.
- **Keep one item for Facebook:** move one free physical unit into the independent Facebook slot. A slot already occupied cannot be increased. Customer checkout holds and allocated units are excluded.
- **Return the Facebook item:** remove that one channel reservation. It becomes shared free stock; website availability still depends on publication/variant status.
- **Record the Facebook item as sold:** consume the reserved Facebook unit and one physical unit. This is only a stock record; it does not prove external payment or create a Facebook customer/order.

All actions compare the current variant version and every loaded balance in the same transaction. A changed snapshot is rejected for review. Physical, Facebook, checkout and allocated quantities cannot become inconsistent; no generic release, paid override or edit-balance field is exposed. Unpublished/disabled items can receive stock and maintain their independent Facebook allocation without silently publishing them.

## Existing authority and recovery

Migration0024 adds only an immutable owner-command/audit receipt. It drives the existing `commerce_commands` and a single `commerce_stock_movements` row; `commerce_inventory` remains the balance authority. Before/after assertions and exact command/movement checks abort the parent transaction even when a trigger silently ignores a write. Existing payment/allocation/hold guards and old financial history remain intact. Actor identity is hashed in the audit; raw Admin identity and customer details are not stored or returned here.

The UI stores the original UUID, action and expected quantities in this tab's sessionStorage before POST. A duplicate click, lost response, timeout or remount retains that exact request. **Check original request** is read-only; **Retry same request** cannot apply twice. A missing lookup result is an observation, not proof that an uncertain write failed. Do not clear the saved request, change its key or force stock balances to resolve an uncertain result. Conflicts/storage failures need developer investigation in these local tests.

A confirmed receipt displays the historical snapshot immediately after its action, not current live stock. Reload current stock before another action. Browser-storage failure blocks sending; malformed saved data is retained for recovery. The storage key includes instance and variant so separate test runs cannot silently overwrite each other's requests. Guest carts/order credentials grant no Admin rights.

## Routes and configuration

The detail page is GET-only. Mutations and receipt checks use the separate resource `POST /admin/commerce/inventory/:variantId/commands`, with no UI export, so native fetch receives JSON rather than a rendered document. Approved human identity, exact local checkout configuration and stock UI opt-in precede storage access. POST also enforces exact Origin, bounded URL-encoded form and an action allowlist; client-selected ledger kinds, payment fields and customer inputs are rejected. GET/HEAD of the command resource return405 without stock access.

After a production build, local opt-in is:

```sh
COMMERCE_LOCAL_STOCK_OPERATIONS=1 npm run commerce:local
```

This starts a fresh isolated fictional database and seeds the existing scope singleton even when payment preparation/providers are off. It sets `COMMERCE_OWNER_STOCK_UI=local-test` and `COMMERCE_OWNER_STOCK_WRITES=local-test`; committed deployment configuration and the ordinary runner keep them off. It does not create an Admin login or authorization bypass. The standard local runner still cannot provide an authenticated owner browser; real Access/HTTPS test-environment acceptance remains separate.

To pause new writes in a controlled test environment, keep UI/scope/database/approved identity available and disable `COMMERCE_OWNER_STOCK_WRITES`. Receipt lookup remains available. Removing the UI gate closes the whole page/resource. Stop/revert UI/new actions while preserving0024, commands, movements, receipts and payment history; use reviewed forward repair rather than deleting records, downgrading schema or restoring an old balance. The runner preserves its temporary directory; restarting creates a new instance, not recovery of the previous state.

For layout review only, `npm run admin:shell:preview` provides `/owner-stock-preview`. It uses the actual component with explicit in-memory fictional responses, not Admin authentication, D1, persistence or inventory acceptance. No customer or account credentials are needed.

## Remaining gates

Real temporary D1 tests cover migration with actual legacy financial history/owned hold, all four actions, duplicate/concurrent/actor/scope conflicts, stale views, silent ignored writes and protected stock. Worker/Router tests must also prove native resource JSON, approved identity/Origin/default-off/paused lookup boundaries, and shared stock after a customer hold. UI tests cover consent, uncertainty/remount, original-key recovery and storage failure. Independent inventory/permission review, accurate-head CI and main verification remain merge gates. Actual iPhone Safari/VoiceOver, approved owner browser/UAT, real inspected counts and selected SKU allocations remain unverified. This feature neither authorizes real goods/data nor makes the site ready for sales.
