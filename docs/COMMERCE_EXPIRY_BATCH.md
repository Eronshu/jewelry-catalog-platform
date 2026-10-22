# C06b1a: internal local reservation-expiry batch

Updated 2026-10-21. This slice supplies a bounded, restart-safe **batch engine**, not a scheduled job. No HTTP route, Admin action, Worker scheduled handler, Cron configuration, command against an existing database, or production switch invokes it. The storefront and `/commerce-lab` still do not expire reservations automatically; use the existing session-owned cancellation in the lab. The next separate slice is a reviewed local trigger/driver, before C06b2 recovery and payment work.

## Contract

`expireTestOrderBatch(db, options)` in `app/lib/commerce/order-expiry.server.ts` is server-internal. Supplying a D1 object is not evidence that it is local; callers must verify isolated bindings independently. Current callers are tests using temporary local D1 with `remoteBindings: false` and no env files. Do not expose it as an unauthenticated customer/maintenance route or give clients control of time/cursors.

- `now` is a validated integer millisecond timestamp, defaulting to server time. Injected clocks in tests are fictional, not a customer-controlled expiry setting. The existing 15-minute reservation duration remains a test assumption.
- `limit` defaults to 10, accepts integers 1–25. One ordered query reads at most `limit + 1` candidates; no invocation attempts more than `limit` releases. The extra row indicates a remaining page. There is no loop that drains the entire database.
- Eligible rows are overdue (`reserve_until <= now`), `pending_payment`, payment `not_started`, fulfillment `none`. Started, unknown, succeeded or failed payments, future reservations, held/other fulfillment and non-pending orders are excluded. Processing/unknown need reconciliation, not blind release.
- Candidates use indexed keyset order `(reserve_until, id)` across stored session owners. `after` is the last returned `{ reserveUntil, orderId }`, not an offset. The owner hash is read internally, never supplied by a customer. Selection/results do not include contact/address/payment details; the reused release command still reads the existing test-order snapshot internally. That snapshot currently contains no customer identity, and this is not a general data-isolation guarantee for future order storage.
- Each release reuses `releaseTestOrder` and its existing atomic command → transition → stock ledger operation. Database guards recheck state, payment, deadline and version at write time. Migration `0006_commerce_expiry_hold_guard.sql` additionally refuses expiry if fulfillment became held/non-none between reading and committing. Manual cancellation behavior is unchanged.

## Results, failure and continuation

The result contains bounded `outcomes`, `nextCursor` and `stopped`. Each outcome has only an internal order ID and `cancelled`, `skipped` or `failed`:

- `cancelled`: cancellation is observed, including an idempotent replay or a competing successful cancellation. This is **not** a count of new transitions created by this run. The ledger/transition is the audit authority.
- `skipped`: a fresh read establishes the row disappeared or is no longer eligible after a conflict. It does not authorize later release or claim payment reconciliation is complete.
- `failed`: release did not establish cancellation and the row remains eligible, or its state could not be rechecked. Keep its reservation and surface it for retry/operator investigation. No raw DB exception is returned/logged. A scan outage rejects the batch with a generic error before any item is attempted.

`nextCursor` advances past attempted rows, including failures, so later due orders can make progress. Continue a non-null cursor to finish the tail; `null` finishes that traversal, **not** all unresolved work. Begin a fresh sweep without a cursor to retry failed/skipped-behind-cursor/newly-due rows. A future driver must retain/report failed outcomes and perform fresh sweeps, not silently discard them or permanently keep the final cursor. Failure quarantine/backoff, alerts, operator lookup and scheduling are not implemented by this engine.

An optional `AbortSignal` stops **between** orders. It does not cancel a submitted D1 transaction, infer that an in-flight write rolled back, or release speculative stock. An already-aborted call does no database work. When stopped before the next item, the result preserves the last attempted cursor; the caller may resume it or start from the beginning. After abrupt process death, starting a fresh sweep is safe: committed cancellations are absent from eligible rows, incomplete orders are still candidates, and release commands/transitions are idempotent. No in-memory job state is needed for this safety property.

## Evidence and remaining gates

Run `npx vitest run app/lib/commerce/orders.server.test.ts`. Tests apply real migrations to temporary local D1 and exercise deadline boundaries, tie-stable pagination, channel/physical balance preservation, payment/hold changes after the release read, overlapping batches/manual cancellation, multi-line release rollback with later-page progress, retry, stop and disposal/recreation of the local runtime on the same persisted DB. No production bindings, provider credentials or live transactions are used.

The next local driver needs its own fail-closed invocation boundary, bounded scheduling/retry policy, safe diagnostics and stop/restart evidence. Deployment scheduling, payment-state reconciliation, operator recovery after session loss, real Sandbox and merchant UAT are later gates. Tests do not make the store ready for purchases.

## Stop and rollback

There is no active driver to stop in this slice. Withhold/remove internal batch calls if problems appear; leave existing orders, stock movements and migration 0006 intact. The migration strengthens a trigger and adds a partial index, compatible with prior application code; do not drop tables, delete release history or restore a weaker expiry guard. Reconcile a failed order before any manual compensating stock operation. No automatic restocking, customer notification or payment cancellation occurs here.
