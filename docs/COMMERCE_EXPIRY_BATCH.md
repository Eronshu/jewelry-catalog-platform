# C06b1: local reservation-expiry engine and controlled driver

Status checked 2026-10-26. C06b1a merged in PR #42 (`925c847`); C06b1b and the C06b2a read-only review API merged via #43/#45 into main `4db36f1`. Final functional head `a730e93` passed CI and independent re-review, including the port-normalization fix. C06b1b supplies an **opt-in local driver**, not production scheduling. Default local runs still require manual cancellation; only the isolated runner with `COMMERCE_EXPIRY_MODE=local-test` starts automatic batches. No Cron configuration, merchant account, payment provider or production binding is enabled.

## Contract

`expireTestOrderBatch(db, options)` in `app/lib/commerce/order-expiry.server.ts` is server-internal. Supplying a D1 object is not evidence that it is local; callers must verify isolated bindings independently. Tests use temporary local D1 with `remoteBindings: false` and no env files. The controlled runner constructs fresh local bindings without remote IDs; the capability is not proof of database isolation by itself. Do not proxy it publicly, use its temporary configuration in a deployment, or expose the engine to customer capabilities.

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

`nextCursor` advances past attempted rows, including failures, so later due orders can make progress. Continue a non-null cursor to finish the tail; `null` finishes that traversal, **not** all unresolved work. Begin a fresh sweep without a cursor to retry failed/skipped-behind-cursor/newly-due rows. A future driver must retain/report failed outcomes and perform fresh sweeps, not silently discard them or permanently keep the final cursor. The engine itself supplies no scheduler, quarantine, alerts or operator lookup. The local driver below supplies limited scheduling/backoff and terminal diagnostics; these are not production monitoring.

An optional `AbortSignal` stops **between** orders. It does not cancel a submitted D1 transaction, infer that an in-flight write rolled back, or release speculative stock. An already-aborted call does no database work. When stopped before the next item, the result preserves the last attempted cursor; the caller may resume it or start from the beginning. After abrupt process death, starting a fresh sweep is safe: committed cancellations are absent from eligible rows, incomplete orders are still candidates, and release commands/transitions are idempotent. No in-memory job state is needed for this safety property.

## Evidence and remaining gates

Run `npx vitest run app/lib/commerce/orders.server.test.ts`. Tests apply real migrations to temporary local D1 and exercise deadline boundaries, tie-stable pagination, channel/physical balance preservation, payment/hold changes after the release read, overlapping batches/manual cancellation, multi-line release rollback with later-page progress, retry, stop and disposal/recreation of the local runtime on the same persisted DB. No production bindings, provider credentials or live transactions are used.

Driver tests cover readiness, exact-origin/capability denial before storage/router access, bounded input, pagination, fresh sweeps, 503 backoff, timeout/transport failure, non-overlap and stop/late response. An integration test runs the actual driver through the Worker boundary on migrated local D1: 11 overdue reservations across sessions, stop after the first 10, new driver starts without a cursor, remaining one releases and replay creates no further transitions. This is in-process Request/Response integration, not real network/provider evidence; compiled-runner smoke is recorded separately in the execution log. Deployment scheduling, payment-state reconciliation, operator recovery after session loss, real Sandbox and merchant UAT are later gates. Tests do not make the store ready for purchases.

## Stop and rollback

Stop the runner with Ctrl-C, or restart without `COMMERCE_EXPIRY_MODE`. This removes future invocations; it cannot undo a committed cancellation or prove an in-flight transaction rolled back. Withhold/remove the driver if problems appear; leave existing orders, stock movements and migration 0006 intact. The migration strengthens a trigger and adds a partial index, compatible with prior application code; do not drop tables, delete release history or restore a weaker expiry guard. Reconcile a failed order before any manual compensating stock operation. No automatic restocking, customer notification or payment cancellation occurs here.

## C06b1b local invocation and scheduling

```sh
npm run build
COMMERCE_EXPIRY_MODE=local-test npm run commerce:local
```

Only this explicit mode creates a random per-run 256-bit capability in the fresh temporary directory's `.dev.vars` (0600). It is not printed or sent to page loaders. The normal Worker deployment file and its bindings are unchanged; it has no capability or Cron. The runner still ignores inherited API credentials and repository dotenv files. Every runner launch creates a new fictional database, never accepts a DB path, and leaves prior data intact.

The internal `/_local/commerce/expiry` handler requires the existing explicit local commerce mode, HTTP loopback URL, **exact Origin including port**, and the bearer capability before touching storage. A missing/wrong setting or capability returns generic 404/no-store/noindex. The runner uses authorized GET/405 for read-only readiness (up to 30 one-second startup retries), then POST with exact JSON content type and at most 512 bytes. Only an optional validated cursor is accepted; callers cannot supply owner, clock, limit or database. Server time and a fixed 10-order batch apply. Browser sessions, including the lab, do not receive this capability. Loopback and this token do not replace production authentication or verified local bindings.

The driver awaits one complete batch per tick and waits 30 seconds after completion before the next page. At end of traversal it starts a fresh sweep on the next tick, rediscovering failures and newly due orders. Per-order failure retains the hold and prints counts plus a developer-investigation warning, then later pages can progress. A completed scan-503 retries the same page after 60/120/240/300 seconds (capped), resetting backoff after a valid result. There is no rapid unbounded drain, automatic quarantine or unlimited in-memory failed-ID set. Durable pending orders and command/transition history remain the source for investigation.

Transport errors, a 15-second timeout, unauthorized/malformed/stopped replies **stop the driver** after readiness, because a request may have committed even if its response was lost. No automatic retry of uncertain HTTP writes is claimed. Stop clears future ticks and aborts the outstanding client request; server cancellation is best-effort between orders. An in-flight D1 transaction may still commit. Inspect state before restarting; a newly constructed driver starts a fresh sweep safely. Tests prove this on the same local DB/runtime, not a public restart/resume command. The standard runner deliberately creates a fresh DB on a new invocation; it does not provide arbitrary existing-state reopening.

Terminal output reports observed cancelled/skipped/failed counts and continuation/health, never bearer values, owner hashes, snapshots or raw exceptions. A configured flag in the lab means **configured**, not proof that its driver is currently healthy; refresh after checking terminal output to observe committed states. Repeated failures require the developer to stop/investigate. The protected C06b2a read-only review API is merged; the owner-friendly exception view and recovery operations remain future separate PRs. Production alerts, durable job tracking and payment reconciliation remain later gates.
