# Fictional portfolio catalog

This catalog is a demonstration of the jewelry platform, not a real shop.
**Velaform Studio** is a temporary fictional display name. The proposed
`velaform-studio.example` is a reserved example-domain placeholder, not a
registered or functioning domain. The working public link remains the existing
Cloudflare Worker Preview. Its `workers.dev` pages have `noindex`; a real
domain and search indexing are separate launch work.

The generator creates 300 clearly named `Demo` products, 75 in each of the
four migrated categories, with one distinct 640×640 WebP concept illustration
per product. Prices, materials, quantities, and availability are synthetic.
Descriptions state that nothing is for sale. There are no purchase or
Facebook Marketplace links. These illustrations are generated from SVG code
in this repository; no third-party product photography is used.

## Rebuild the files

```sh
npm ci
npm run demo:generate
```

The ignored `.wrangler/portfolio-demo/` directory receives `manifest.json`,
`seed.sql`, `rollback.sql`, `interleave-existing.sql`, and 300 image files. The generator is
deterministic. Fixed product IDs `500001`–`500300` and image IDs
`600001`–`600300` keep every R2 key attributable to this dataset.
The generated timestamps interleave the four categories in Newest sort.
Generated binary images and the SQL file are intentionally not committed.
Do not run the old `seeds/development.sql` against the Preview: it contains
missing-image placeholders.

## Isolated local check

Use an empty local D1 state:

```sh
npx wrangler d1 migrations apply DB --local --persist-to .wrangler/portfolio-demo-local
npm run demo:import:local
```

The importer refuses a nonempty catalog, uploads the exact manifest images
to local R2, then inserts the matching D1 rows. The local Worker must use the
same `--persist-to` directory to display these products. This command does
not contact remote Cloudflare resources.

## Preview import

This is for the dedicated, already migrated **Preview** D1 and private R2
bucket only. The importer has no production mode. Before running it, review
`wrangler.jsonc` and `wrangler.preview-migrations.jsonc`, confirm the
signed-in account, verify the Preview catalog has zero products, images and
upload rows, and inspect the manifest and sample images. Pass the verified
account ID as `EXPECTED_CF_ACCOUNT_ID` in the operator environment; do not
commit that ID to this document.

```sh
EXPECTED_CF_ACCOUNT_ID=<verified-id> node scripts/import-portfolio-demo.mjs --preview
```

The script checks the account and Preview bindings, requires an empty D1
catalog, uploads 300 images to the dedicated Preview R2 bucket, and only then
inserts D1 rows. Successful completion verifies counts of 300 products and
300 images. A failed image batch leaves D1 unchanged; rerun uploads with the
same manifest keys after resolving the failure. A failed D1 import requires
inventorying the partial rows before any retry.

After import, verify Home, Shop pagination, a product detail, and an image URL
on both the moving and current immutable Preview URL. Confirm the site's
noindex header, the Admin Access gate, and the fictional labels. The
application code changes to branding require a separately built Worker
Preview deployment; importing data alone does not update the Worker.
An earlier generated seed used category-block timestamps; the generated
`interleave-existing.sql` corrects only those fixed-range `demo-%` rows
and is unnecessary for a new import.

## Removal

Review `.wrangler/portfolio-demo/rollback.sql` and the current D1 rows
before using it. The SQL first returns only fixed-range `demo-%` products
to Draft, then deletes their image and product rows. Delete only the 300 R2
keys in `manifest.json` after the D1 rows have been removed. Verify zero
matching rows and absent exact objects, and check that sampled public product
and image URLs return 404. Do not use a bucket-wide delete.
