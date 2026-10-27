# Jewelry Catalog Platform

A full-stack jewelry catalog and owner-facing Admin built with React Router,
TypeScript, and Cloudflare Workers. The project began as a future small-business
website and currently runs as **Velaform Studio**, a fictional portfolio demo.

**[Explore the live demo](https://protected-cloudflare-preview-jewelry-catalog-platform.shugegogogo.workers.dev/)** ·
[Browse the 300-product catalog](https://protected-cloudflare-preview-jewelry-catalog-platform.shugegogogo.workers.dev/shop) ·
[Read the project case study](./docs/PORTFOLIO_CASE_STUDY.md)

> **Demo scope:** The brand, products, prices, and illustrations are fictional.
> Nothing is for sale. The protected Admin is not a public demo account. This
> Preview has `noindex`; a custom domain and production launch are future work.

## What the project demonstrates

- A server-rendered storefront with category browsing, search, filters, sorting,
  product details, responsive images, and 24-item Load More pagination.
- An owner-facing Admin for drafts, publishing, product updates, status changes,
  and photo upload and ordering, protected by Cloudflare Access and a Worker JWT
  check.
- An isolated Cloudflare Preview using D1 for catalog data, private R2 for image
  originals, and Cloudflare Images for delivery. The 300 demo products and
  distinct WebP concept illustrations are reproducible from the generator;
  generated binaries are not committed.
- Automated formatting, lint, type checks, tests, and a production build in CI.

The public demo remains a catalog that directs interested customers to the
owner's sales channel. Separate local-only work now includes a cart, delivery
form/test quotes, lab reservations and protected operator review/recovery
commands. Customer checkout is not bound to a payable order; hosted payments
and the complete operating workflow are not implemented. The full V1 scope and architecture are in
[PROJECT_SPEC.md](./PROJECT_SPEC.md); demo data and cleanup are documented in
[docs/PORTFOLIO_DEMO.md](./docs/PORTFOLIO_DEMO.md). The owner's draft
requirements for a future real-sales phase are in
[docs/ONLINE_SALES_REQUIREMENTS.md](./docs/ONLINE_SALES_REQUIREMENTS.md),
with a platform comparison and implementation plan in
[docs/ONLINE_SALES_IMPLEMENTATION_PLAN.md](./docs/ONLINE_SALES_IMPLEMENTATION_PLAN.md).
The ordered remaining work, business dependencies and release gates are in
[the commerce launch roadmap](./docs/COMMERCE_LAUNCH_ROADMAP.md). A merged local
feature does not mean the public demo is ready to accept purchases.
An isolated [local payment sandbox](./docs/PAYMENT_SANDBOX_SPIKE.md) can be used
to compare Stripe and PayPal test flows without changing the live catalog.

The Shop route reads public products from its D1 binding and links cards to
product detail pages. Home features the four newest public catalog products;
hero and editorial photography remain temporary design assets. Private R2
image delivery is configured. A protected Admin is running on the isolated
Worker Preview. Production launch and a real domain remain separate work.

## Requirements

- Node.js 24.21.0 (see `.node-version`)
- npm

Use a Node version manager that understands `.node-version`, or install the
documented version directly. The project also declares the supported Node range
in `package.json`.

## Local setup

```sh
npm ci
npm run db:migrate:local
npm run db:seed:local
npm run dev
```

The development server uses the Cloudflare Vite plugin so server code runs in a
local Workers-compatible runtime. No environment values or Cloudflare
credentials are required for ordinary local development. `.env.example`
documents the policy for adding them later.

## Local catalog database

The `DB` binding in `wrangler.jsonc` uses a local D1 database without a remote
database ID. Apply the versioned schema before using server-side catalog reads:

```sh
npm run db:migrate:local
```

Wrangler stores local D1 state under the ignored `.wrangler/state` directory.
The command above explicitly uses `--local` and does not create or modify a
remote D1 database. Four initial categories are migration data. To add 24
completely fictional products for local development only, run
`npm run db:seed:local`. The Shop shows 22 public seed products (20 Available,
2 Sold); Draft and Hidden records stay private. Public seed products have image
metadata with `dev/products/...` placeholder keys; no R2 objects or
deliverable photos exist yet, so Shop cards show their image-failure fallbacks.
The seed must never be treated as production inventory or applied to a remote
database. Home's design-review fixture is separate and is never imported into
D1 or used by Shop.

To rebuild only this catalog D1 database from migrations, stop the dev server
and run `npm run db:reset:local`. The script drops the catalog tables and their
named migration ledger through an explicitly local D1 command, verifies the
ledger name against `wrangler.jsonc`, and reapplies migrations. It leaves other
local Cloudflare binding state intact. Optionally rerun the development seed.
This is destructive to local catalog data only. Never use these scripts for
production data; remote database creation and migrations are separate launch
work.

## Local image delivery

`PRODUCT_IMAGES` is a locally simulated, private R2 binding. `IMAGES` is the
locally simulated Cloudflare Images transformer. Neither requires a remote
bucket or credentials for development. The local transformer supports only a
subset of production features; image quality and edge caching need preview
deployment verification later.

Image URLs have the form `/media/products/<product-id>/<image-id>/<profile>`.
Profiles are `thumb`, `card`, `detail`, and `zoom`. The URL contains no bucket
name or object key. The server checks that the image row belongs to a public
product before reading R2. New original keys must be immutable and have the
form `products/<product-id>/<uuid>.jpg`, `.jpeg`, `.png`, or `.webp`.
Replacing a photo requires a new key and image row so cached URLs are not
reused. Delivery validates the object's R2 `httpMetadata.contentType`; the D1
table has no content type column.
Workers Cache can serve a hit before the Worker checks D1. A photo that was
public may therefore remain available at its cached URL after its product is
marked Hidden or Archived, until that entry expires. The D1 public-status
check applies on a cache miss and is not an immediate revocation guarantee.
Admin removal does not immediately revoke a previously cached public response;
a purge or shorter cache policy is needed if prompt revocation is required.

To verify the pipeline without product photography, generate one small,
fictional checker image locally:

```sh
node scripts/create-local-image-fixture.mjs
npm run db:migrate:local
npm run db:seed:local
npx wrangler r2 object put jewelry-catalog-images-local/products/1001/123e4567-e89b-12d3-a456-426614174000.png --file=.wrangler/fixtures/fictional-checker.png --content-type=image/png --local
npx wrangler d1 execute DB --local --command="INSERT INTO product_images (product_id, r2_key, alt_text, sort_order, width, height, created_at) VALUES (1001, 'products/1001/123e4567-e89b-12d3-a456-426614174000.png', 'Synthetic checker test image', 99, 64, 64, 1780000000000)"
npm run dev
```

The inserted row's ID can be read with
`npx wrangler d1 execute DB --local --command="SELECT id FROM product_images WHERE r2_key = 'products/1001/123e4567-e89b-12d3-a456-426614174000.png'"`.
Request `/media/products/1001/<image-id>/card` with `curl -i`. The result
should be WebP with a public cache header. These commands use `--local` only.
The existing `db:reset:local` command resets D1 but intentionally leaves local
R2 objects intact; remove this one with `npx wrangler r2 object delete
jewelry-catalog-images-local/products/1001/123e4567-e89b-12d3-a456-426614174000.png
--local` when finished.

The checked-in development seed contains placeholder image metadata without
R2 objects. It is not production inventory. A real private production bucket,
binding configuration, and image uploads are separate deployment work.

For a browser check of Shop covers and the detail gallery, use a separate
synthetic local product after applying the migrations and fictional seed. Run
`node scripts/create-local-image-fixture.mjs`, then put two local-only objects:

```sh
npx wrangler r2 object put jewelry-catalog-images-local/products/9001/123e4567-e89b-12d3-a456-426614174001.png --file=.wrangler/fixtures/fictional-checker.png --content-type=image/png --local
npx wrangler r2 object put jewelry-catalog-images-local/products/9001/123e4567-e89b-12d3-a456-426614174002.png --file=tests/fixtures/still-photo.png --content-type=image/png --local
```

Then create the matching local-only D1 rows (choose another unused product ID
and adjust the keys if `9001` already exists):

```sh
cat > /tmp/jewelry-storefront-qa.sql <<'SQL'
INSERT INTO products (id, name, slug, price_cents, category_id, status, created_at, updated_at)
VALUES (9001, 'Synthetic Orbit Ring', 'synthetic-orbit-ring', 3199, 4, 'draft', 1791060000000, 1791060000000);
INSERT INTO product_images (product_id, r2_key, alt_text, sort_order, width, height, created_at)
VALUES (9001, 'products/9001/123e4567-e89b-12d3-a456-426614174001.png', 'Checker front view', 0, 64, 64, 1791060000000);
INSERT INTO product_images (product_id, r2_key, alt_text, sort_order, width, height, created_at)
VALUES (9001, 'products/9001/123e4567-e89b-12d3-a456-426614174002.png', 'Purple side view', 1, 64, 64, 1791060000000);
UPDATE products SET status = 'available' WHERE id = 9001;
SQL
npx wrangler d1 execute DB --file=/tmp/jewelry-storefront-qa.sql --local
npm run dev
```

Open `/shop` and `/products/synthetic-orbit-ring`.
The owner-approved Issue #17 public display keeps SKU internal to admin; Shop
and product detail do not load or show it to customers.
The checker should be the cover; reordering the two saved positions should
change the public cover and primary gallery image on a fresh read. This fixture
is local-only and must never be used as production inventory. The existing
fictional seed's missing objects should be used to check image fallbacks, not
successful delivery. Physical iPhone Safari and deployed protected-preview
checks remain separate launch gates.

Never commit `.env`, `.dev.vars`, Cloudflare tokens, account identifiers, or
production data. Browser-visible values must be treated as public. Server-only
admin settings belong in `.dev.vars` locally and Cloudflare secret management
for deployed environments.

## Admin access foundation

`/admin` has a small owner-facing shell. Every `/admin`, `/admin.data`, and
`/admin/*` request must pass the Worker guard before React Router runs. Future admin loaders,
actions, and resource routes must also call `requireAdmin` from
`app/lib/auth/admin-access.server.ts`. Admin responses, including denials, are
`private, no-store`; public image delivery retains its existing cache behavior.

The Worker validates the Cloudflare Access application JWT in
`Cf-Access-Jwt-Assertion` using the team's JWKS, RS256, exact issuer and
audience, and required time claims. It accepts only a verified human JWT with
nonempty `email` and `sub` that match the same configured administrator pair.
Service-token-shaped claims are rejected. A header, cookie, or decoded claim
alone does not grant access. The Cloudflare Vite build includes Static Assets,
whose internal router does not pass `ctx.access` to the application Worker.

These server-only settings are required before `/admin` can be used:

- `ADMIN_ACCESS_ISSUER`: exact HTTPS team URL, such as
  `https://your-team.cloudflareaccess.com`, without a trailing slash.
- `ADMIN_ACCESS_AUD`: audience tag for the admin Access application.
- `ADMIN_IDENTITY_PAIRS`: JSON array of approved `{ "email", "sub" }` pairs.
  Obtain each human `sub` through an authenticated Access identity flow during
  later policy setup. The `sub` can change if a person is removed and re-added
  to the Zero Trust organization; review and update the approved pair then.

Missing or invalid settings make `/admin` unavailable. Ordinary `npm run dev`
does not bypass verification. Tests use fictional identities and synthetic
signing keys. To inspect only the presentational shell in a local browser, run
`npm run admin:shell:preview` and open the printed loopback URL. This separate
Vite fixture lives under `tests/`, outside the application routes and Worker
build; it does not test authentication or grant access to `/admin`. Opening the
fixture's source `index.html` directly in a file preview does not run its
TypeScript/React entry point; use the Vite URL instead.

Before real owner use, configure a Cloudflare Access application limited to
specifically approved identities, with strong account security. Inventory all
reachable Worker hostnames and paths, including preview URLs, `workers.dev` if
enabled, and custom domains. Protect exact `/admin`, its React Router data
request `/admin.data`, and nested `/admin/*` on each reachable hostname, or
disable that hostname. Review more-specific
Access policy precedence. On a protected preview deployment, verify that the
real Access assertion reaches the application Worker through the deployed
Static Assets topology; an approved human can open `/admin`, request
`/admin.data`, and open a nested admin URL; unapproved and unauthenticated
visitors cannot; and alternate hostnames
cannot bypass either Access or the application guard. Verify admin no-store
headers and unchanged public Home, Shop, and image behavior. Local tests do not
replace this deployment gate. No real Access policy or remote resource is set
up by this issue.

## Admin product management

The protected admin has a product list at `/admin/products`, an Add Product
form, and edit forms. New and duplicated products are always Draft. Saving or
changing status from an edit form validates and saves every displayed field in
one version-checked update. List quick actions submit only the displayed
product version. A stale action asks the owner to refresh rather than
overwriting another tab's edit. Archived products are read-only until restored
to Draft. There is no permanent product deletion.

The `0002` migration stores a unique request key and payload hash on created
products. Retrying the same create or duplicate request returns the original
product, even after later edits. New publication from Draft or Hidden requires
a valid image row and an existing private R2 object with a matching content
type and supported size. Public-to-public status changes do not repeat the R2
check. This check cannot make R2 and D1 atomic; an object may disappear after
the check. Image transformation is verified separately, not during each owner
action. The public image route and its existing cache behavior are unchanged.

For local list, search, filter, and form presentation, apply local migrations
and the 24-row fictional seed as described above. Its image rows are metadata
placeholders, so they cannot prove a thumbnail or publication. The standalone
`npm run admin:shell:preview` fixture now provides Welcome, List, Form, Form
errors, and Photos scenes at `/`, `/list`, `/form`, `/error`, and `/photos`. The
Form scene shows the one-Save photo picker. It is presentation only; submitting
it does not exercise product actions or authentication.

### Protected product photos

On Add product, enter details and select photos before clicking Save. The page
creates a private Draft, then uploads valid selections sequentially. Product
details become a saved, locked summary once creation is confirmed. Failed
photos can be retried without creating another Draft or resending successful
photos; invalid selections can be removed or replaced. The page opens Edit
automatically when the selected queue is resolved, and offers an Edit Draft link
while photos need attention. The ordinary no-JavaScript form still creates a
Draft and redirects to Edit without uploading photos.

The Add photos button opens the file picker; the surrounding area accepts dropped files but does not open the picker when clicked. The picker accepts multiple
JPEG, PNG, or still WebP files up to **18,000,000 bytes each**, with at most 10
files and 100 MB selected at once. The editor separates unsaved local previews
from saved photos, uploads one file at a time, shows per-file progress, and
retries failures without resending successes. HEIC/HEIF, animated WebP, and
APNG are rejected clearly. Files over the limit are not downscaled: an accepted
private R2 original contains the exact selected bytes. Existing fixed image
profiles transform that original for public delivery. Photos beyond the cap
remain an explicit limit for protected-preview review.
Before Save on Add, selected photos can be dragged by their handles or moved
with the Move earlier and Move later buttons into the desired upload order;
the first successfully saved photo becomes the cover. On Edit, drag a saved
photo by its handle to reorder it, or use the same buttons. Compact photo rows
show the current order; each row's Actions control opens its secondary tools.
The first saved photo is the cover. Reordering saves
the photo order immediately; product details have their own Save action.
Describe this photo edits alternative text, not pixels. Cropping, resizing the
original, and adding visible text to an image are not part of this issue.

On Add, navigation warns while details are unsaved, files remain selected, or
creation/uploads are active. An in-flight request may finish after the owner
confirms leaving, but later queued photos do not start. A same-tab reload keeps only the creation request key and a
known Draft ID long enough to look up saved server state; selected browser files
are lost and uploads do not resume. If the lookup is uncertain, check Products
before starting another Draft. No photo bytes, upload UUIDs, or digests are
stored for reload recovery.

Leaving the edit page while an upload is uploading or finishing prompts once,
including through in-app Back and browser history. Unsaved product details use
the same prompt; completed or merely selected photos do not trigger it. If the
owner confirms leaving, the editor does not explicitly abort the request, but
its final result is uncertain after navigation or page unload; later queued
photos do not start. On returning,
the editor reloads saved photos; the owner should check that list before
selecting the file again. Retries while the editor stays open retain the same
upload UUID.

Migration `0003` stores a stable upload UUID, canonical product-specific R2
key, byte length, SHA-256, type, reservation state, and committed version. It
also records the last business-field revision separately from photo revisions.
The server verifies the
digest against the bounded request bytes, including on retry; it never trusts
the browser digest header alone. A D1 image row is inserted only after R2 put
and image validation. An active reservation with an R2 object can be completed
on retry after a D1 failure or lost response. An interrupted R2 write releases
its reservation for an immediate retry. A live write renews a five-second
lease; after an unexpected worker stop, an identical retry can take over when
that lease expires. Conditional R2 writes keep the original immutable. A committed retry returns the
current photo snapshot. The product form advances with that snapshot only if
its business fields have not changed elsewhere. `Content-Length` is optional;
the server measures the actual request and compares any declared length.
The ascending unique
`sort_order` defines the cover. Photo mutations use versioned, guarded D1
batches. Protected previews enforce Access and product/image ownership for all
statuses and send `private, no-store`; public media eligibility is unchanged.
Previously cached public image URLs retain their delayed-revocation limit.

The fictional seed's placeholder rows are not upload evidence. The isolated
photo tests create a temporary local D1/R2 environment, apply migrations, use
the synthetic files under `tests/fixtures`, and remove their bindings. The
`/photos` admin shell scene is a **visual fixture only**. Its illustrated photos
and reorder feedback are temporary; it cannot save data.
`npm run typecheck` includes this fixture so its component props stay current.

R2 and D1 do not commit atomically. To reconcile old orphans, an operator must
identify expired active reservations, mark one abandoned only when no image
row references its upload ID, and recheck the exact R2 key for D1 references
before deletion. Keep terminal reservations so late retries cannot recreate a
removed photo. Repeat the sweep after the lease window to catch an in-flight
writer that finishes late. Removal commits D1 first; failed R2 deletion is
logged and can be retried through the reference-aware removed-upload reconciler.
Never bulk-delete a
product prefix. Production cleanup needs a separately reviewed key list and
human approval.

Before real owner use, verify real Cloudflare Access, deployed Static Assets
routing, production Images behavior, and physical iPhone Safari on a protected
preview. Local simulation and the visual fixture cannot establish those gates.

Run `npm test` for isolated functional QA. Admin D1/R2 tests create their own
temporary local persistence directory, apply migrations there, create an
Archived fixture and a Draft with a synthetic PNG original, test publication
and transformation, then dispose of the bindings and remove that directory.
They do not change the ordinary `.wrangler/state` database or bucket. If a
test process is interrupted, remove only its `jewelry-admin-d1-test-*`
directory under the system temporary directory after confirming that process
has stopped. The normal local seed remains untouched by these tests.

Before owner use, review a protected preview deployment with real Cloudflare
Access. Check approved and denied users on document and `.data` URLs, all
reachable hostnames, no-store headers, save and lifecycle actions, a real
deliverable image, and desktop plus iPhone Safari layout. Synthetic tests and
the standalone visual fixture do not replace that gate.

## Commands

| Command                       | Purpose                                                    |
| ----------------------------- | ---------------------------------------------------------- |
| `npm run dev`                 | Start the local Cloudflare-compatible development server   |
| `npm run admin:shell:preview` | Preview only the presentational admin shell on loopback    |
| `npm run build`               | Create the production client and Worker bundles            |
| `npm run db:migrate:local`    | Apply pending migrations to local D1 only                  |
| `npm run db:reset:local`      | Rebuild only the local catalog D1 schema                   |
| `npm run db:seed:local`       | Add fictional local catalog data                           |
| `npm run preview`             | Preview the production build locally for manual validation |
| `npm run format`              | Format project files                                       |
| `npm run format:check`        | Check formatting without changing files                    |
| `npm run lint`                | Run ESLint                                                 |
| `npm run typecheck`           | Generate platform/route types and run TypeScript checks    |
| `npm test`                    | Run the test suite once                                    |
| `npm run test:watch`          | Run tests in watch mode                                    |
| `npm run validate`            | Run all non-interactive validation checks and the build    |

## Project structure

- `app/` — React Router application shell, routes, and styles
- `workers/` — Cloudflare Worker entry point
- `.github/workflows/` — validation-only continuous integration

## Deployment

Production deployment is not configured. The production build targets
Cloudflare Workers and Static Assets, but this branch has only an isolated
Worker Preview with dedicated D1 and R2 resources. Its setup, acceptance
checks, and rollback steps are documented in
[docs/PROTECTED_PREVIEW_RUNBOOK.md](./docs/PROTECTED_PREVIEW_RUNBOOK.md).
