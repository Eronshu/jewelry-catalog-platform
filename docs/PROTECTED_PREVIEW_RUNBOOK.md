# Isolated Worker Preview: deployment and acceptance gates

This runbook records the deployment order and acceptance gates for the isolated
Worker Preview on `workers.dev`. A preview-only custom domain is a fallback.
Production deployment, production resource creation, and production DNS are
outside scope. Keep account identifiers, emitted URLs, Access identity claims,
and secret values in the owner's private operational record, not this file.

As of 2026-10-09, the owner-approved remote phase has created dedicated Preview
D1 and private R2 resources, applied migrations `0001`–`0003`, created the
Worker Preview and one Access application, and configured Preview-only Admin
secrets. The owner opened the protected Admin product list in Safari. An
authorized synthetic item with two generated test images then passed the Draft,
private image preview, alt text, photo ordering, publish, public WebP/media
cache, and Sold checks on the moving and both emitted immutable Preview URLs.
The item and both exact R2 objects were removed afterward; D1 again held zero
products, images, and upload records, and the public item and media URLs
returned 404. The owner reported that the physical iPhone Safari check passed
for Home, Shop, Access login and the Admin list, and View website navigation.
The occasional slow first navigation from Admin to Home remains undiagnosed;
the Admin link now keeps the current page visible while Home loads. Remaining
manual and deployed checks in the matrix below must still be reviewed.

## Prepared configuration

`wrangler.jsonc` retains its existing top-level local D1/R2 bindings, Worker,
Static Assets, Images, and cache settings. Its `previews` block declares the
same runtime binding names (`DB`, `PRODUCT_IMAGES`, `IMAGES`) with dedicated
Preview D1/R2 targets. `wrangler.preview-migrations.jsonc` targets that same
Preview D1 database through `PREVIEW_DB`. Recheck the paired D1 name and ID in
both files against the account inventory before any further remote migration;
never use the local or an eventual production database. The top-level Worker
configuration is not a production resource manifest.

Worker Previews do not inherit production bindings, but Preview Base settings
and secrets can supply values to new Previews. Inventory those settings before
creation. The first Preview used `--ignore-base-config` because the new
Worker's Base settings could not yet be inspected. Reject any
unknown or production binding or Admin secret that the Preview would use. The
`previews` block must explicitly bind all resources used by the app. Cloudflare
documents [Preview configuration](https://developers.cloudflare.com/workers/previews/configuration/)
and [D1/R2 isolation](https://developers.cloudflare.com/workers/previews/resources/).

## Resource and action inventory template

The **unknown** entries below describe preflight questions for a new account or
resource, not the current Preview's status. Record the real value, account
prerequisite, estimated billing effect, and rollback evidence in a private,
human-reviewed manifest before the corresponding action.

| Action or resource | Proposed value and purpose                                                                     | Prerequisite and cost to verify                                                       | Rollback or disable                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Worker Preview     | Worker name **unknown**; Preview name **unknown**; branch code only                            | Worker name availability, Preview support and limits, Workers plan/usage              | Delete only the recorded Preview; verify both URLs stop serving                        |
| D1                 | New Preview database name/ID **unknown**, bound as `DB`                                        | D1 capacity, limits, rows read/written, storage and billing plan                      | Preserve evidence, then delete only the recorded Preview database after cleanup review |
| R2                 | New private Preview bucket name **unknown**, bound as `PRODUCT_IMAGES`                         | R2 subscription, operations, storage and billing plan; no public bucket URL           | Delete only recorded synthetic keys, then the recorded bucket                          |
| Images             | `IMAGES` API binding, transforming private R2 bytes                                            | Images plan and unique-transformation allowance                                       | Remove with the Preview                                                                |
| Access             | One self-hosted application name/AUD **unknown** for the three Admin path classes              | Zero Trust, identity provider, policy permissions, plan/seat limits, wildcard support | Remove only this Preview Access app after disabling the Preview                        |
| Preview secrets    | `ADMIN_ACCESS_ISSUER`, `ADMIN_ACCESS_AUD`, `ADMIN_IDENTITY_PAIRS`; values never in Git or logs | Real human Access flow, one verified application audience                             | Remove only this Preview's settings                                                    |
| Hostname           | Preferred moving and immutable `workers.dev` URLs, actual names **unknown**                    | Account subdomain, Preview URL setting and existing hostname rules                    | Disable Preview URLs or delete the Preview                                             |

Check current [Workers](https://developers.cloudflare.com/workers/platform/pricing/),
[D1](https://developers.cloudflare.com/d1/platform/pricing/),
[R2](https://developers.cloudflare.com/r2/pricing/), and
[Images](https://developers.cloudflare.com/images/pricing/) pricing in the
approved account before creation. Do not assume included allowance or a paid
subscription. R2 requires an [R2 subscription](https://developers.cloudflare.com/r2/get-started/).

## Hostnames and Access coverage

Cloudflare documents a moving Preview URL
`<preview-name>-<worker-name>.<account-subdomain>.workers.dev` and an immutable
deployment URL `<deployment-id>-<worker-name>.<account-subdomain>.workers.dev`.
Both are public by default. A hostname/path-specific Access application may
protect `workers.dev`; it covers only matching URLs. A candidate host pattern
is `*-<worker-name>.<account-subdomain>.workers.dev`. The current Access
application has been observed challenging the moving URL and the emitted
immutable URLs on the three canonical Admin path classes. Repeat coverage
checks for every later immutable URL and confirm the wildcard does not protect
an unrelated Worker. See
[Worker Previews](https://developers.cloudflare.com/workers/previews/),
[Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/),
and [Access wildcard rules](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/).

| Reachable host form                                                                          | Public routes                   | Admin `/admin`, `/admin.data`, `/admin/*`                                      |
| -------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------ |
| Moving Preview `workers.dev` URL                                                             | Public synthetic storefront     | One Access application with all three path entries, plus Worker JWT guard      |
| Every immutable deployment `workers.dev` URL                                                 | Same                            | Same application and audience; verify each emitted hostname                    |
| Production `workers.dev`, legacy Version URLs/aliases, custom domains/routes, any other host | Inventory; do not assume absent | Disable or establish equivalent explicit protection and test before acceptance |

Use **one self-hosted Access application** for exact `/admin`, exact
`/admin.data`, and `/admin/*` so a single application AUD reaches the Worker's
`ADMIN_ACCESS_AUD`. The account UI's support for multiple path entries under
one application is a **gate to verify**, not an assumption. Do not create three
applications with different AUD values and do not loosen the Worker's JWT
audience, issuer, signature, or approved email/`sub` checks. `/admin/*` does not
cover `/admin`; review more-specific policy precedence. If one app cannot
cover the required paths and both URL forms, stop and revise the deployment
proposal before setting secrets. [Application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/).

The Worker must run before Static Assets on canonical Admin routes. The
existing `run_worker_first` entries are `/admin`, `/admin.data`, `/admin/*`.
Local tests cover canonical document, data, action, upload, and private preview
paths and assert the Worker recognizes encoded/case variants. The production
build also checks its generated `run_worker_first` entries and rejects any
static asset whose decoded/case-folded URL occupies the Admin namespace.
Static Assets
pattern matching for those variants and the generated deployment topology
remain **deployed verification gates**; local tests cannot prove them. Inspect
the build asset manifest for any Admin namespace asset before the first
Preview. If a variant can bypass the Worker or Access, disable the Preview.
[Static Assets routing](https://developers.cloudflare.com/workers/static-assets/binding/).

## First-Preview bootstrap order and checks for later deployments

1. **Account inventory before creating any Preview:** inspect all existing
   Worker hostnames, routes, Version URLs/aliases, Access applications and
   precedence, Preview URL setting, Preview Base bindings/secrets/variables,
   and other settings a new Preview could receive. Check Zero Trust, identity
   provider, account subdomain, permissions, plans and limits. Base settings
   for a Worker that does not exist cannot be inspected; the first Preview
   command below explicitly ignores them. If any setting the Preview would
   actually use is unknown or production-linked, stop before creation.
2. Choose unused Worker and Preview names from that inventory. Confirm the
   candidate `workers.dev` Access host wildcard and the ability to use one
   application with all three Admin paths and one AUD. If the UI allows it,
   configure that Access application before the first Preview. If it requires
   an existing Worker or emitted host, leave Admin secrets absent and continue
   only with the locally checked fail-closed Worker.
3. Create only the approved Preview D1 database and private R2 bucket. Enter
   their confirmed identifiers in the `previews` block and the matching
   migration configuration. Review the diff: no local or production resource
   may appear in Preview bindings. Apply `0001`, `0002`, `0003` using
   `npx wrangler d1 migrations apply PREVIEW_DB --remote --config wrangler.preview-migrations.jsonc`
   only after checking the selected name and ID. Record the `catalog_migrations`
   ledger and schema evidence. Never transfer `.wrangler/state` or run
   `seeds/development.sql` remotely.
4. Build with `npm run build`, then inspect `build/server/wrangler.json` and
   `build/client`. The generated configuration must name
   `jewelry-catalog-platform`, set `main` to `index.js`, point
   `assets.directory` to `../client`, retain the three Admin
   `run_worker_first` patterns, and contain only the recorded Preview D1/R2
   targets in its `previews` block. The application guard must return `503`
   when its three Admin settings are missing. After the other account gates
   pass, create the first Worker Preview from the built output with:

   ```sh
   npx wrangler preview --config build/server/wrangler.json --name protected-cloudflare-preview --ignore-base-config
   ```

   The explicit generated config selects the built Worker and client assets;
   its `previews` block supplies the Preview-only bindings. The explicit name
   avoids using the slash-containing Git branch name. `--ignore-base-config`
   excludes uninspectable Preview Base settings; pass no `--var` or
   `--secrets-file` while Admin is fail-closed. `npm run preview` is a local
   Vite preview and does not create a remote Worker Preview. Cloudflare
   explicitly supports creating a first Preview without a production Worker
   deployment. **Never use `wrangler deploy` for bootstrap.**
   [Get started](https://developers.cloudflare.com/workers/previews/get-started/);
   [Preview configuration](https://developers.cloudflare.com/workers/previews/configuration/).

5. Immediately record the moving and immutable URLs. Test `/admin`,
   `/admin.data`, nested documents/actions, uploads, private photo previews,
   and encoded/case variants with no Access session or assertion. None may
   serve Admin data or assets. If any does, disable/delete the Preview and
   investigate before proceeding. Complete the one Access application against
   the actual emitted hostnames if it was not accepted before creation.
6. Verify both URL forms are challenged or denied by Access on all three
   normal Admin path classes while `/`, `/shop`, public product detail, and
   public media stay reachable unauthenticated. Re-inventory every emitted
   and enabled host. Disable or explicitly protect and test any extra host.
7. Only after Access coverage passes, set `ADMIN_ACCESS_ISSUER`, the **one**
   application `ADMIN_ACCESS_AUD`, and approved human
   `ADMIN_IDENTITY_PAIRS` through Preview-only secret management. Obtain and
   compare the human `email`/`sub` through a real authenticated Access flow
   without printing them in Git, logs, or test reports. Verify approved,
   missing, and unapproved assertions on every reachable hostname.
8. Create only recorded synthetic products and a non-business photo. Complete
   the acceptance matrix below. For every later Preview deployment, rebuild
   and reuse the explicit generated-config command above. Each deployment
   emits a new immutable URL: record and verify it before accepting it.

Cloudflare's [Preview configuration](https://developers.cloudflare.com/workers/previews/configuration/)
distinguishes Preview Base secrets from individual Preview secrets. Before the
first Worker existed, its Base settings could not be inspected in advance;
the explicit `--ignore-base-config` flag kept them out of that Preview.

## Noindex boundary

Cloudflare automatically adds `X-Robots-Tag: noindex` to `workers.dev` Preview
URLs. Verify the header on HTML from both moving and immutable URLs. No
repository-wide `_headers` or Worker noindex rule is added, so future
production HTML remains unaffected. If the custom-domain fallback is later
chosen, design a conditional header for **Preview HTML only**, and verify that
production-mode HTML does not receive it. [Preview custom domains](https://developers.cloudflare.com/workers/previews/custom-domains/).

## Acceptance matrix and rollback

Run the existing local test suite, lint, typecheck, format check, build, and
`git diff --check` before review. Deployed tests must run on **both** the
moving URL and every emitted immutable URL, plus any other enabled hostname.

| Check                                                                                                           | Local                                            | Deployed Preview                                          | Owner/manual                       |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------- | ---------------------------------- |
| Admin exact, data, nested document, action, upload, and private preview; approved, missing, unapproved identity | Worker/JWT tests                                 | Access and Worker denial/allow on each hostname           | Desktop and physical iPhone Safari |
| Encoded/case Admin spellings and direct Static Assets requests                                                  | Worker recognition and asset-manifest inspection | Prove no bypass on each hostname                          | Browser network review             |
| Public Home, Shop, product detail, and media without Access session                                             | Existing tests                                   | Synthetic data on each hostname                           | Desktop and physical iPhone Safari |
| Draft, photo upload/order, private preview, publish, Sold; real WebP/content type                               | Local D1/R2 tests                                | Recorded synthetic item/photo and real Images binding     | Owner workflow                     |
| Admin `private, no-store`, public image cache, generic errors                                                   | Existing tests                                   | Response headers and generic failures                     | Review                             |
| Noindex boundary and rollback                                                                                   | No global noindex rule; reproducible config      | Preview HTML has noindex; verify Preview removal/rollback | Review evidence                    |

If protection fails, first disable the affected Preview URL or delete the
recorded Preview, then verify both URLs no longer serve. Revert to a known-good
Preview deployment only after checking that its immutable URL is also covered.
Code rollback does not roll back D1/R2 state. Preserve migration and test-data
records. Cleanup may remove only recorded synthetic rows and exact R2 keys;
do not bulk-delete by prefix. Retire the dedicated Preview D1 and R2 resources
only after confirming no other Preview binds them. See
[Worker versions and storage](https://developers.cloudflare.com/workers/versions-and-deployments/).

## Custom-domain fallback

If the `workers.dev` host/path policy fails account verification, propose a
preview-only custom domain under an owner-approved Cloudflare zone. Its moving
URL is `<preview-name>.<preview-domain>`; immutable URLs are
`<deployment-id>-<preview-name>.<preview-domain>`. Configure the domain through
Worker **Domains → Add Domain → Enable for: Preview**, after the fail-closed
first Preview exists; confirm wildcard certificate and Access coverage on both
forms, and disable or protect `workers.dev`. The documented Wrangler route
setup uses `wrangler deploy`, which is a production deployment operation and
is excluded here. Domain acquisition, DNS setup, and possibly deeper-hostname
certificate features may have cost. This fallback needs its own reviewed
approval before any action. [Preview custom domains](https://developers.cloudflare.com/workers/previews/custom-domains/).
