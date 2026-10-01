# Jewelry Catalog Platform

A Cloudflare-native React Router application for a small-business jewelry
catalog and its future owner-facing administration tools. The V1 product scope
and architecture are defined in [PROJECT_SPEC.md](./PROJECT_SPEC.md).

The Shop route reads public products from its D1 binding. Home still uses a
labeled visual design fixture. Private local R2 image delivery is configured,
but Shop cards deliberately retain placeholders until real catalog imagery is
integrated. A protected admin foundation is present, but real Cloudflare Access
configuration and deployment are not configured yet.

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
deliverable photos exist yet, so Shop cards show square photo placeholders.
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
table has no content type column and does not need a migration for this issue.
Workers Cache can serve a hit before the Worker checks D1. A photo that was
public may therefore remain available at its cached URL after its product is
marked Hidden or Archived, until that entry expires. The D1 public-status
check applies on a cache miss and is not an immediate revocation guarantee.
Future admin removal needs a purge or a shorter cache policy if prompt
revocation is required.

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

Deployment is not configured by Issue #1. The production build targets
Cloudflare Workers and Static Assets, but no Cloudflare resources, live
bindings, preview deployments, production deployments, or credentials are
created by this scaffold.
