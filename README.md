# Jewelry Catalog Platform

A Cloudflare-native React Router application for a small-business jewelry
catalog and its future owner-facing administration tools. The V1 product scope
and architecture are defined in [PROJECT_SPEC.md](./PROJECT_SPEC.md).

The Shop route reads public products from its D1 binding. Home still uses a
labeled visual design fixture. Private local R2 image delivery is configured,
but Shop cards deliberately retain placeholders until real catalog imagery is
integrated. Authentication, admin features, and deployment are not configured yet.

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
production data. Browser-visible values must be treated as public. Future
server-only secrets should be stored locally in `.dev.vars` and in Cloudflare's
secret management for deployed environments.

## Commands

| Command                    | Purpose                                                    |
| -------------------------- | ---------------------------------------------------------- |
| `npm run dev`              | Start the local Cloudflare-compatible development server   |
| `npm run build`            | Create the production client and Worker bundles            |
| `npm run db:migrate:local` | Apply pending migrations to local D1 only                  |
| `npm run db:reset:local`   | Rebuild only the local catalog D1 schema                   |
| `npm run db:seed:local`    | Add fictional local catalog data                           |
| `npm run preview`          | Preview the production build locally for manual validation |
| `npm run format`           | Format project files                                       |
| `npm run format:check`     | Check formatting without changing files                    |
| `npm run lint`             | Run ESLint                                                 |
| `npm run typecheck`        | Generate platform/route types and run TypeScript checks    |
| `npm test`                 | Run the test suite once                                    |
| `npm run test:watch`       | Run tests in watch mode                                    |
| `npm run validate`         | Run all non-interactive validation checks and the build    |

## Project structure

- `app/` — React Router application shell, routes, and styles
- `workers/` — Cloudflare Worker entry point
- `.github/workflows/` — validation-only continuous integration

## Deployment

Deployment is not configured by Issue #1. The production build targets
Cloudflare Workers and Static Assets, but no Cloudflare resources, live
bindings, preview deployments, production deployments, or credentials are
created by this scaffold.
