# Refunded order stock release (Issue #99)

This default-off loopback Admin workflow is a fictional whole-order test assumption, not the store’s refund/return policy. It does not request money, receive returned goods or change the original payment, refund and handoff history.

## Owner workflow

From order details choose **Release refunded order stock**. The server must find the original canonical paid order, a verified matching full refund and no handoff. The owner checks that every original item is still in the store and sellable, then explicitly confirms release of that exact whole-order allocation. If goods are missing or unsuitable, leave the allocation protected for review.

Release decreases only allocated stock. Physical, Facebook and checkout quantities remain unchanged because the goods were already present. An already packed but unhanded order may retain its historical packing receipt; refund intent still blocks handoff. An original handed-off order must use the separate physical return inspection process instead. Pending, failed, uncertain or mismatched refunds do not authorize release.

The new movement is an explicit canonical `deallocate`, with immutable original-request and whole-order line receipts. Generic inventory commands do not accept this movement; only the protected release receipt may authorize it. Four inventory balances and original quantities must still match at the atomic write. Existing protection for every unrelated paid or unknown order stays in place. A refund intent by itself never exempts an order from its allocated floor.

## Configuration, pause and recovery

`COMMERCE_LOCAL_ALLOCATION_RELEASE=1 npm run commerce:local` enables the local UI and new-write flags in a new isolated fictional database. It reads no provider credentials and supplies no Admin authentication bypass or automatically paid/refunded fixture. Existing approved Admin authentication and the same checkout instance are required. The explicit flags are `COMMERCE_OWNER_ALLOCATION_RELEASE_UI=local-test` and `COMMERCE_OWNER_ALLOCATION_RELEASE_WRITES=local-test`.

Remove only the writes flag to pause new releases. Preserve the UI, database, original instance and approved access for original-request lookup/history. The browser saves UUID, order version and stock hash before POST. A lost response, `not_recorded` lookup or mismatched receipt does not prove failure: retain the original request and investigate rather than starting a replacement. The server permits at most one whole-order release, including across different request IDs or actors. Never erase a receipt, rewind a refunded database, fake handoff/return or directly patch balances as recovery.

## Acceptance gates

Local core validation passed 24 real-D1 tests, including populated 0028 upgrade/history and failed-migration rollback; both provider histories; exact full-refund association; no handoff; whole-order once-only deallocation and unchanged physical stock; unrelated paid/unknown floors and old guards; races, silent-ignore rollback, original-request recovery and final authorization. Additional original-quantity-two and REPLACE/UPSERT floor cases passed in the affected tests. Independent actual stock/permission review found no unresolved findings and independently ran three targeted D1 cases. Integrated format/lint/generated project and fixture TypeScript, 103 files/1,823 application tests (173.49 seconds), six offline payment HTTP simulations and production build/Admin asset protection passed. Exact-head PR CI is still required before delegated merge; this document does not claim that unfinished gate is complete.

The separate paused `/owner-allocation-release-preview` uses fictional props. It is not authentication, D1, a provider call, actual Safari/VoiceOver or owner UAT. The two original actual Sandbox payment/refund databases remain untouched during implementation. Production, real goods, real policy and launch authorization remain separate gates.
