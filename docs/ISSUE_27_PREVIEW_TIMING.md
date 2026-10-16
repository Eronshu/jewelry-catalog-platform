# Issue 27: first Preview storefront navigation

## Empty-catalog trace, 2026-10-10

The moving Preview and one immutable deployment were tested from Toronto with
fresh `curl` processes, no cookies, and `Cache-Control: no-cache`. Preview D1
then contained no products. A new in-app browser tab also rendered each Home
page. These requests bypass browser cache but **do not guarantee a cold
Cloudflare Worker isolate or a fresh Safari profile**.

| Request                                            | Moving Preview | Immutable deployment |
| -------------------------------------------------- | -------------: | -------------------: |
| Home HTML, five distinct query strings, TTFB range |     100–125 ms |            97–146 ms |
| Home HTML, one earlier no-cache sample             |         382 ms |               101 ms |
| Shop HTML, one no-cache sample                     |         236 ms |               224 ms |
| Missing synthetic product, 404                     |         156 ms |               145 ms |

All document requests above had zero redirects. The 200 Home response contained
the hero heading and Shop link in the initial 10.3 KB of HTML. On the moving
Preview, the first-party CSS took 89 ms total and the 215 KB JavaScript entry
took 78 ms total in separate requests. The external editorial hero image took
529 ms to first byte and 580 ms total (424 KB) in a separate request. A browser
visit to the immutable homepage completed in about 3.2 seconds, with the
heading visible and all editorial images loaded by the time navigation
completed. A 390 px browser viewport showed the heading and Shop link. This
browser is not iPhone Safari, and navigation-completion time is not a measured
first-paint time.

The Home loader performs one D1 product read before server rendering. The
Worker bypasses Admin authentication for public routes. The initial HTML
already contains visible copy, so hydration and image loading are not required
to show the heading once HTML arrives. Current measurements do not reproduce a
long blank interval or identify a code change that would reduce it. A slow
Worker/D1 response, a stalled client navigation data request, and device or
network variability remain possible during the intermittent report. The Admin
link currently retains Admin while a Home data request is pending; its delayed
navigation regression test passes.

## Synthetic Preview product trace

After confirming Preview D1 had zero products, images, and uploads, one Draft
named “Issue 27 Synthetic Checker Ring” was created through Admin with the
repository-generated 64 × 64 checker PNG. Its product ID, image ID, upload ID,
and exact R2 key were recorded and verified before publishing. No business
photo or inventory was used. Normal GETs observed first and repeat requests.

| Request                   | Moving Preview first / repeats | Immutable first / repeats |
| ------------------------- | -----------------------------: | ------------------------: |
| Home HTML TTFB            |              126 / 119, 112 ms |         120 / 130, 129 ms |
| Shop HTML TTFB            |              175 / 174, 179 ms |         172 / 168, 225 ms |
| Product HTML TTFB         |              164 / 141, 160 ms |         139 / 160, 143 ms |
| Product detail image TTFB |              628 / 289, 206 ms |         178 / 190, 168 ms |

Every request returned 200 with zero redirects. The image returned WebP,
182 bytes, and `Cache-Control: public, max-age=86400,
stale-while-revalidate=604800`. Its first moving-host request was slower than
the page HTML, but did not delay that HTML. The 64 px fixture exercises the
D1/R2/Images route but does not measure behavior for a large phone photo.

In the in-app browser, **View website** from Admin reached the visible Home
heading in 212 ms; opening the synthetic product reached its visible heading
in 205 ms. The image subsequently completed with `naturalWidth=64`. The
immutable product page also rendered its heading and completed the image.
Neither browser visit showed “Photo unavailable.” These are browser automation
wall times, not paint metrics or iPhone Safari measurements.

`ProductPhoto` displays “Loading photo…” while a non-null image source is
pending. “Photo unavailable” requires a null source or a failed image request.
The public media route reads D1, then R2, then transforms through Images; its
failure responses are not cached. The image symptom cannot explain blank Home
HTML because image delivery is a separate request.

For rollback, only the recorded product was returned to Draft, then its one
product row was deleted with a predicate checking its name, slug, image ID,
upload ID, and exact R2 key. The image and upload rows cascaded. Only the
recorded R2 object was deleted. Preview D1 again showed zero product, image,
and upload rows; an exact R2 lookup reported no object; the public product and
image URLs returned 404 on both hosts. No code was deployed.

## Reproduction and next measurement

1. In a fresh iPhone Safari Private tab, open Admin and tap **View website**.
   Record when the tap occurs, when the first Home text appears, and whether
   Admin remains visible while the request is pending. Repeat once in the same
   tab. Separately open the moving and immutable public Home URLs in fresh tabs.
2. Capture the Home document or route-data request status, redirects, TTFB,
   and total time, then first-party CSS/JavaScript and the editorial hero image
   separately. A mobile Safari Web Inspector network trace is needed if the
   long delay returns. Do not export cookies, Access assertions, or Admin data.
3. If the intermittent delay returns, identify the slow request in the Safari
   trace before choosing a code fix. A further synthetic product test would
   need a separately reviewed Preview action and exact-item cleanup.

No application code or Preview deployment change was made. The approved
synthetic data was created and removed as described above. Production remains
untouched.
