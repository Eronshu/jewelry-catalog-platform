# Jewelry Catalog & Admin System — PROJECT_SPEC.md

**Status:** V1 specification — frozen for initial implementation  
**Last reviewed:** 2026-09-28  
**Primary goal:** Build a polished, production-ready jewelry catalog website with a Shopify-like admin experience, while keeping recurring infrastructure cost near zero at the current business scale.

---

## 1. Product Summary

This project is a small-business jewelry catalog and product management system for a non-technical owner who currently sells jewelry primarily through Facebook Marketplace.

The public website should present the brand professionally, make browsing fast and enjoyable, and direct interested customers to the existing sales/contact channel. The owner must be able to manage products through a simple web admin interface without touching code, GitHub, databases, command-line tools, or deployment settings.

The V1 product is **not a full e-commerce checkout system**. It is a branded catalog + admin system designed to support roughly 100 products initially and scale comfortably to several hundred without architectural changes.

---

## 2. Core Product Principles

1. **Non-technical owner first**  
   The owner should be able to add, edit, publish, hide, duplicate, mark sold, archive, and reorder product images entirely through a visual admin UI.

2. **Low cost must not mean low quality**  
   Infrastructure should stay on free/low-cost tiers where reasonable, but UX, accessibility, responsiveness, error handling, image quality, perceived performance, and safety should feel comparable to a polished paid small-business platform.

3. **Mobile first**  
   Facebook Marketplace traffic is expected to be heavily mobile. iPhone Safari is a first-class target, not an afterthought.

4. **Image-first design**  
   Jewelry photography is the primary content. Product images must load quickly without sacrificing detail on product pages.

5. **Simple operations**  
   Routine business tasks should take very few clicks. Frequent actions must be easy; destructive actions must be guarded.

6. **Production safety**  
   Public users must never be able to mutate catalog data. Secrets must never be exposed to the browser or committed to GitHub.

7. **Easy future migration**  
   The architecture should allow future migration to Shopify or another commerce backend if direct checkout becomes necessary.

---

## 3. V1 Scope

### Included in V1

- Public homepage
- Shop/catalog page
- Category pages/filtering
- Product detail pages
- Search
- Filter and sort
- Load More pagination
- Responsive design
- Optimized product image delivery
- Lazy loading
- Admin authentication
- Admin dashboard
- Add product
- Edit product
- Duplicate product
- Save as draft
- Preview product
- Publish product
- Mark product as sold
- Hide product
- Archive product
- Product image upload
- Product image reordering
- Cover image selection
- Facebook Marketplace URL per product
- SEO metadata
- Sitemap
- robots.txt
- Product structured data where appropriate
- Error states and loading states
- Basic analytics
- Backup/recovery plan
- Automated deployment from GitHub
- Preview deployments for changes before production

### Explicitly deferred from V1

- Shopping cart
- Direct checkout
- Credit-card payment processing
- Shipping calculation
- Order management
- Refunds
- Customer accounts
- Complex inventory reservations
- Multi-location inventory
- Automated Facebook Marketplace listing creation
- AI-generated product descriptions as a required feature
- Loyalty/favorites system
- Discount engine
- Full ERP features

---

## 4. Target Users

### Customer

Typical behavior:

- Arrives from Facebook, search, direct link, or social sharing.
- Browses visually on mobile.
- Filters by jewelry type/material/colour/availability.
- Opens a product detail page.
- Looks closely at product photos.
- Uses the Facebook Marketplace link or contact method to continue the purchase conversation.

### Owner / Admin

The owner is non-technical.

The admin experience must **never expose implementation concepts** such as:

- database rows
- buckets
- SQL
- object keys
- deployment
- API tokens
- IDs unless they are user-facing SKUs
- GitHub
- Cloudflare internals

The owner should only see business concepts such as Products, Photos, Price, Category, Draft, Sold, Publish, Archive, and Preview.

---

## 5. Recommended Production Architecture

### Application framework

- React Router v8 full-stack application
- TypeScript
- Vite
- Cloudflare Vite plugin
- Tailwind CSS
- Accessible component primitives where useful (e.g. Radix/shadcn-style patterns), while keeping the storefront visually custom to the jewelry brand

### Hosting and backend

- Cloudflare Workers
- Cloudflare Static Assets
- Cloudflare D1 for structured product data
- Cloudflare R2 for original product images
- Cloudflare Images transformations for responsive delivery and format optimization
- Cloudflare Access to protect the admin area

### CI/CD

- GitHub as source of truth
- Cloudflare Workers Builds connected to GitHub
- Production deployment from `main`
- Preview deployment for pull requests / feature branches before merge

### Why this architecture

The system is intentionally Cloudflare-native so that hosting, server functions, database, storage, CDN, image transformation, access control, and deployment can remain simple and inexpensive for a small catalog.

At the expected V1 scale, infrastructure should normally stay within free-tier limits. The only unavoidable recurring cost should generally be the custom domain unless traffic or feature usage grows substantially.

---

## 6. Cost Target

### Target recurring infrastructure cost at V1 scale

- Hosting / Worker usage: target $0/month on free tier
- D1: target $0/month on free tier
- R2: target $0/month within included allowance
- Image transformations: target $0/month within free transformation allowance
- Cloudflare Access: target $0/month
- SSL/CDN: included
- Domain: expected separate annual cost

### Upgrade triggers

Upgrade to Workers Paid only if one or more of the following becomes true:

- normal traffic approaches free Worker limits
- D1 free read/write limits become an operational risk
- more backup history is needed
- production usage meaningfully exceeds free-tier capacity
- paid support becomes important

Do not pre-emptively upgrade solely for perceived prestige or convenience.

---

## 7. Public Information Architecture

### Required routes

- `/` — Home
- `/shop` — Main catalog
- `/shop?category=earrings`
- `/shop?category=necklaces`
- `/shop?category=bracelets`
- `/shop?category=rings`
- `/products/:slug` — Product detail
- `/about`
- `/contact`
- `/privacy`
- `/terms`

### Optional later routes

- `/new-arrivals`
- `/sale`
- `/collections/:slug`

---

## 8. Storefront UX Requirements

### Home page

Should include:

- Brand logo and identity
- Hero section with strong jewelry photography
- Primary CTA to Shop
- New arrivals or featured products
- Category shortcuts
- Short brand story
- Contact / Facebook CTA
- Mobile-friendly footer

### Shop page

Must support:

- product card grid
- search
- category filter
- material filter
- colour filter
- availability filter
- sort by newest / price where appropriate
- Load More pagination
- URL-persisted filter state where practical
- graceful empty state

### Product card

Show only essential information:

- cover image
- product name
- price in CAD
- sold-out badge when applicable

Avoid overloading product cards with long descriptions.

### Product detail page

Must include:

- image gallery
- larger optimized images
- zoom or close inspection behavior
- product name
- CAD price
- availability status
- description
- material
- colour
- optional SKU
- Facebook Marketplace / contact CTA if available
- related products when practical

Sold products should normally remain accessible and display `Sold Out` rather than becoming a 404 immediately.

---

## 9. Admin Experience

Admin UX should feel inspired by mature platforms such as Shopify in clarity and workflow quality, but should not copy proprietary branding or interface details exactly.

### Admin navigation

- Dashboard
- Products
- Add Product
- Optional Categories management
- Sign out

### Product list

Provide:

- search
- filters: All / Available / Sold / Draft / Hidden / Archived
- product thumbnail
- name
- price
- status
- updated date
- quick actions

### Quick actions

High-frequency actions should be available without entering the full edit form where safe:

- Mark Sold
- Mark Available
- Duplicate
- Hide / Show
- Preview

Archive should require confirmation.

Permanent delete should not be part of the normal V1 workflow.

### Add/Edit Product form

Fields:

- Product name — required
- Price CAD — required
- Category — required
- Material
- Colour
- Description
- SKU — optional
- Quantity — optional; do not require if owner only needs Available/Sold
- Facebook Marketplace URL — optional
- Status: Draft / Available / Sold / Hidden
- Product photos — at least one required before publishing

### Product image management

Admin must support:

- drag/drop or file picker
- multi-image upload
- upload progress
- retry on failure
- image preview before save
- reordering
- setting cover image
- removing an image with confirmation
- clear handling of large phone photos

The owner should not manually resize or optimize images.

### Draft and preview workflow

Recommended flow:

1. Add product
2. Upload photos
3. Enter business information
4. Save Draft automatically or explicitly
5. Preview
6. Publish

If editing a published item, unsaved changes must not silently disappear.

---

## 10. Product Lifecycle

Allowed statuses:

- `draft`
- `available`
- `sold`
- `hidden`
- `archived`

### Behavior

`draft`  
Not visible publicly.

`available`  
Visible publicly and available for purchase/contact.

`sold`  
Product page remains accessible; clearly display Sold Out.

`hidden`  
Not shown publicly but retained for future reuse.

`archived`  
Retained as historical data and excluded from normal admin views unless archive filter is selected.

Use soft deletion. Do not permanently delete normal product records from the UI.

---

## 11. Data Model

### `products`

- `id`
- `name`
- `slug`
- `sku`
- `description`
- `price_cents`
- `category_id`
- `material`
- `colour`
- `status`
- `quantity` nullable
- `facebook_url` nullable
- `created_at`
- `updated_at`
- `published_at` nullable
- `sort_order` nullable

Store money as integer cents, not floating-point currency.

### `categories`

- `id`
- `name`
- `slug`
- `sort_order`
- `is_active`

Initial categories:

- Earrings
- Necklaces
- Bracelets
- Rings

These are defaults, not hard-coded permanent limits.

### `product_images`

- `id`
- `product_id`
- `r2_key`
- `alt_text`
- `sort_order`
- `is_cover`
- `width` nullable
- `height` nullable
- `created_at`

### Optional `site_settings`

May store business-facing content that should be editable later, such as:

- Facebook profile/page URL
- contact method
- homepage announcement
- social links

Do not overbuild a CMS in V1.

---

## 12. Slug Rules

The owner never manually manages slugs by default.

Example:

`Pearl Drop Earrings` → `pearl-drop-earrings`

Requirements:

- automatic generation
- normalized lowercase
- URL-safe characters
- collision handling
- slug should not unexpectedly change after publication simply because the display name changes
- admin may later be given an advanced slug override if needed

---

## 13. Image Architecture

### Storage

- Store originals in Cloudflare R2.
- Do not bundle product images into the application repository.
- Never require the owner to manually optimize images.

### Delivery

Use Cloudflare Images transformations to produce right-sized outputs from R2 originals.

Recommended display profiles:

- `thumb` — admin/search thumbnails
- `card` — catalog grid
- `detail` — main product gallery
- `zoom` — high-detail inspection

Use automatic modern-format negotiation where practical.

### Image behavior

- Product cards use 1:1 visual frames for consistent grids.
- Preserve the complete original image for detail/zoom where practical.
- Do not stretch images.
- Use object-fit behavior intentionally.
- Store or infer image dimensions to prevent layout shift.
- Add meaningful alt text.

### Lazy loading

- Hero/LCP image should be prioritized.
- Below-the-fold product images should lazy load.
- Avoid loading all images for all products on first catalog render.

### Upload validation

Accept common phone/image formats that can be safely processed. At minimum design for:

- JPEG/JPG
- PNG
- WebP

HEIC/HEIF handling must be tested before launch. If the chosen processing path does not reliably support a user's phone format, the admin must show a clear friendly error rather than fail silently.

Reject unsupported file types.

Add a reasonable upload size limit and clear user-facing validation message.

---

## 14. Pagination and Data Loading

The catalog must not fetch the entire product table and every image on initial load.

### Default catalog behavior

- Initial batch: 24 products
- UI pattern: `Load More`
- Additional batch: 24 products

### Backend behavior

- Use indexed database queries.
- Fetch only fields needed for the card listing.
- Do not fetch full descriptions/gallery data for every card.
- Prefer cursor/keyset pagination when practical; offset pagination is acceptable for V1 if query behavior remains simple and stable at the expected scale.

### Filters

Filtering should occur server-side or in a way that does not require downloading the full catalog first.

---

## 15. Responsive Design

Use mobile-first responsive layout.

Target classes of devices rather than hard-coding for specific phone models.

### Representative validation widths

- 360px small phone
- 390–430px common modern phones
- 768px tablet portrait
- 1024px tablet landscape/small laptop
- 1280px laptop
- 1440px desktop
- 1920px wide desktop

### Suggested catalog grid behavior

- small mobile: 2 columns
- tablet: 3 columns
- desktop: 4 columns
- wide desktop: 4–5 columns depending on card size and brand design

Do not allow the wide-screen layout to stretch indefinitely. Use a sensible max content width.

### Browsers to validate before launch

- Safari on iPhone — high priority
- Safari on macOS
- Chrome on desktop
- Chrome responsive/mobile emulation
- Edge desktop
- iPad Safari where possible

---

## 16. Performance Requirements

The site should feel fast on normal Canadian mobile connections.

### Targets

- LCP target: under 2.5 seconds under reasonable production test conditions
- CLS target: near zero
- Avoid large initial JavaScript bundles
- Initial homepage transfer target: roughly under 1–1.5 MB where practical
- Lighthouse targets as guidance, not as vanity metrics:
  - Performance: 90+
  - Accessibility: 90+
  - Best Practices: 95+
  - SEO: 95+

### Techniques

- responsive images
- image transformations
- lazy loading
- route-level data loading
- cache public catalog responses appropriately
- avoid unnecessary client-side JavaScript
- prefetch intentionally, not indiscriminately
- reserve image dimensions
- use skeletons sparingly for perceived responsiveness

---

## 17. Caching and Freshness

Public catalog pages may be cached for performance, but product edits must become visible quickly.

Requirements:

- Publishing or updating a product should revalidate/invalidate affected cached content.
- Price, status, and availability changes should appear within seconds, not hours.
- Admin pages must not be publicly cached.
- Never cache authenticated admin content in shared public caches.

---

## 18. Authentication and Authorization

### Admin protection

Use Cloudflare Access to protect `/admin` and admin mutation endpoints.

Preferred V1 approach:

- restrict admin access to specifically approved Cloudflare account member(s) or approved identity/email policy
- require strong account security / MFA where available
- no public self-registration

### Application authorization

Do not rely only on hiding the admin page in the UI.

All write endpoints/actions must verify trusted authenticated admin access server-side.

Public users may only read publicly visible products.

---

## 19. Security Requirements

- Never commit secrets, API tokens, or private keys to GitHub.
- Use Cloudflare secrets / environment variables for protected configuration.
- Add `.env*`, `.dev.vars`, and relevant local secret files to `.gitignore`.
- Validate all admin inputs server-side.
- Use prepared/bound D1 queries; do not concatenate untrusted SQL.
- Sanitize or safely render description content.
- Validate URL schemes for Facebook links.
- Validate uploads by type and size.
- Use CSRF-safe framework/action patterns for authenticated mutations.
- Rate-limit abuse-prone public endpoints if needed.
- Contact form, if included, must include anti-spam protection such as Cloudflare Turnstile.
- Do not reveal internal stack traces to public users.
- Add appropriate security headers.

---

## 20. SEO and Sharing

Each public product should have a stable human-readable URL:

`/products/pearl-drop-earrings`

### Required SEO

- unique page title
- meta description
- canonical URL
- Open Graph metadata
- social preview image
- sitemap.xml
- robots.txt
- descriptive image alt text
- Product structured data where accurate and appropriate

Do not publish misleading schema fields for features the site does not support.

Sold items may remain indexable if that continues to provide useful content and related-product discovery.

---

## 21. Accessibility

Meet strong baseline accessibility standards.

Requirements:

- semantic HTML
- keyboard navigation
- visible focus states
- labels for form controls
- useful form validation messages
- sufficient contrast
- touch targets sized appropriately
- images have alt text or explicit decorative treatment
- status is not conveyed only by color
- dialogs/modals manage focus correctly
- drag-and-drop image ordering must have a non-drag alternative if practical

---

## 22. Error and Empty States

Do not allow silent failures or blank screens.

### Public

- catalog loading state
- product not found state
- no filter results state
- failed catalog load state with retry
- missing Facebook URL hides the CTA rather than rendering a broken button
- missing image uses a graceful fallback

### Admin

- upload progress
- upload failure with retry
- save success confirmation
- save failure with entered data preserved
- unsaved changes warning where appropriate
- clear field validation
- duplicate SKU warning if SKU is used
- network error message
- safe destructive-action confirmation

Use toast/status messages appropriately, but important failures must not disappear before the user understands them.

---

## 23. Backup and Recovery

Use Cloudflare D1 Time Travel for short-term point-in-time recovery.

Additionally implement a simple longer-term backup workflow before launch or shortly after:

- periodic database export
- store export outside the live D1 database, such as R2 and/or a separately retained offline copy
- keep a recovery document with tested restore steps

Product images in R2 should be treated as business assets. A periodic external/offline backup strategy should be documented if the original source photography is not reliably retained elsewhere.

A backup that has never been tested is not considered a complete backup plan.

---

## 24. Analytics and Observability

Keep analytics lightweight and privacy-conscious.

Track useful business events where practical:

- page views
- product detail views
- category views
- Facebook outbound clicks
- most viewed products

Use Cloudflare built-in observability and logs where sufficient.

Add a separate error-monitoring service only if operational experience shows it is needed; do not add recurring cost automatically in V1.

Set up usage/billing notifications where available so unexpected traffic cannot become a surprise.

---

## 25. GitHub Repository Strategy

The project should live in GitHub from the beginning.

### Initial visibility

Use a **private repository** during development and initial production launch.

Reasons:

- version history
- rollback capability
- code review
- Codex repository workflow
- Cloudflare CI/CD integration
- protects unfinished code and brand/business details while the project is developing

The repository may later be made public as a portfolio project only after reviewing/removing:

- secrets
- private configuration
- private customer/business information
- unnecessary production identifiers
- copyrighted/private brand assets if the owner does not want them public

### Recommended branch workflow

- `main` — production-ready, deployable branch
- `feature/<short-name>` — normal development
- pull request before non-trivial merges

For a one-developer project, do not overcomplicate GitFlow.

### Merge rules

Before merge to `main`:

- build passes
- lint/typecheck passes
- relevant automated tests pass
- preview deployment reviewed for user-visible changes
- no secrets in diff
- database migrations reviewed

---

## 26. Repository Safety

Required `.gitignore` coverage:

- node_modules
- local build artifacts
- `.env`
- `.env.*` except intentionally committed example files
- `.dev.vars`
- local Cloudflare state where appropriate
- OS/editor junk

Commit an `.env.example` only with variable names/placeholders, never real values.

Never commit:

- Cloudflare API token
- account secret
- service token
- private keys
- production cookies/session data
- user credentials

If a secret is accidentally committed, removing it in a later commit is not sufficient; rotate the secret immediately.

---

## 27. CI/CD and Deployment

### Development

1. Work locally on a feature branch.
2. Run development server in Cloudflare-compatible runtime.
3. Run checks/tests.
4. Push branch to GitHub.
5. Review preview deployment.
6. Merge to `main`.
7. Cloudflare deploys production automatically.

### Production

- custom domain points to Cloudflare
- TLS/SSL enabled
- production D1 and R2 bindings separated from local/test resources
- admin Access policy enabled before public launch
- backups verified

### Rollback

Code rollback:

- revert or redeploy a known-good Git commit/deployment

Data rollback:

- use D1 Time Travel only when necessary and only after confirming the intended restore point

Do not couple routine code rollback with destructive database rollback.

---

## 28. Database Migration Rules

Use explicit version-controlled migrations.

Requirements:

- migrations committed to GitHub
- do not edit production schema manually without recording the migration
- additive/backward-compatible changes preferred
- destructive migrations require backup/recovery review
- seed/demo data must be clearly separated from production data

---

## 29. Testing Strategy

### Automated baseline

- TypeScript typecheck
- lint
- build
- unit tests for important utility/business logic
- integration tests for product CRUD where practical
- Playwright or equivalent end-to-end tests for critical workflows

### Critical admin E2E flows

At minimum test:

1. Admin access succeeds for approved admin.
2. Unauthorized visitor cannot use admin routes.
3. Add product.
4. Upload multiple images.
5. Reorder images.
6. Save draft.
7. Preview draft.
8. Publish product.
9. Product appears publicly.
10. Edit price.
11. Mark sold.
12. Duplicate product.
13. Archive product.

### Critical storefront E2E flows

1. Home loads.
2. Shop loads first 24 products.
3. Load More works.
4. Category filter works.
5. Search works.
6. Product detail route works.
7. Sold state renders correctly.
8. Facebook CTA only appears when URL exists.

---

## 30. Design Quality Bar

The storefront should feel like a polished boutique jewelry brand, not an admin template.

Direction:

- elegant
- modern
- understated
- strong whitespace
- image-led
- restrained animation
- excellent typography
- smooth hover/touch feedback
- consistent spacing system

The admin should feel:

- clean
- obvious
- calm
- forgiving
- fast
- optimized for non-technical users

Use mature SaaS UX patterns, but do not copy Shopify branding or proprietary UI verbatim.

---

## 31. Interaction Quality Requirements

- buttons have immediate visual feedback
- form submissions show pending/success/error states
- do not allow accidental double-submit
- use optimistic UI only where rollback is safe and understandable
- preserve form state after recoverable errors
- skeletons/spinners should not cause major layout jumps
- modal/dialog transitions should be subtle and fast
- mobile interactions should not depend on hover
- animations respect reduced-motion preferences

---

## 32. Product Search and Filtering

For V1 scale, simple D1 search is sufficient.

Search should consider at least:

- product name
- SKU where present
- category
- material where useful

Do not add Elasticsearch/Algolia or another paid search service in V1.

Indexes should support frequent filters and sorting.

---

## 33. Data Integrity Rules

- `name` required
- `price_cents >= 0`
- valid status enum
- category reference must be valid
- exactly one cover image when images exist
- product image order must be deterministic
- published product must have at least one image
- published product should have meaningful name and price
- malformed Facebook URLs must not be accepted as valid CTA links

---

## 34. Privacy and Legal Baseline

V1 should minimize personal-data collection.

If a contact form collects personal information, provide a clear privacy notice and only collect fields necessary to respond.

Do not collect payment-card data in V1.

Before direct e-commerce is added later, separately review:

- privacy policy
- terms
- return policy
- shipping policy
- tax handling
- payment processor requirements
- consumer-protection obligations

---

## 35. Future Commerce Migration Path

If the business later needs direct web sales, evaluate Shopify rather than automatically building checkout/payment/order management from scratch.

Preferred future options:

### Option A — Full Shopify migration

Move storefront and commerce operations to Shopify if operational simplicity becomes more important than custom architecture.

### Option B — Headless Shopify

Retain custom storefront design while using Shopify for products/checkout/orders where justified.

V1 code should avoid unnecessarily coupling the storefront UI to D1-specific product access so migration remains practical.

---

## 36. Expected Repository Structure

Exact structure may evolve, but maintain clear boundaries.

```text
/
├─ app/
│  ├─ components/
│  │  ├─ storefront/
│  │  ├─ admin/
│  │  └─ ui/
│  ├─ routes/
│  ├─ lib/
│  │  ├─ db/
│  │  ├─ images/
│  │  ├─ auth/
│  │  ├─ validation/
│  │  └─ seo/
│  └─ styles/
├─ migrations/
├─ tests/
├─ public/
│  └─ brand/
├─ workers/
├─ PROJECT_SPEC.md
├─ README.md
├─ .env.example
├─ wrangler.jsonc
└─ package.json
```

Do not store product photography in `public/` except temporary demo assets; production product images belong in R2.

---

## 37. Codex Working Rules

Codex should treat this file as authoritative product/architecture guidance for V1.

For every substantial task:

1. Read `PROJECT_SPEC.md` before implementation.
2. Inspect the existing code before changing architecture.
3. Prefer the smallest maintainable change that satisfies the requirement.
4. Do not silently replace core infrastructure choices.
5. Do not add paid external dependencies/services without explicit approval.
6. Do not add checkout/payment/order features unless explicitly requested.
7. Keep the owner-facing admin non-technical.
8. Never commit secrets.
9. Run typecheck/lint/build/tests relevant to the change.
10. Summarize files changed and any manual setup required.
11. Flag security implications before weakening auth or permissions.
12. Preserve mobile usability and accessibility.
13. Avoid premature abstractions for hypothetical enterprise scale.
14. Keep performance budgets in mind for image-heavy pages.

If implementation reality conflicts with this spec, Codex should explain the conflict and propose a minimal spec amendment rather than quietly diverging.

---

## 38. Implementation Phases

### Phase 0 — Repository and platform setup

- Create private GitHub repository
- Scaffold Cloudflare React Router application
- Add TypeScript/Tailwind
- Configure Worker
- Configure development environment
- Add base CI checks

### Phase 1 — Design system and static storefront shell

- brand assets
- typography
- spacing
- navigation
- footer
- home shell
- shop shell
- responsive behavior

### Phase 2 — D1 catalog backend

- schema
- migrations
- seed/demo products
- product reads
- category reads
- pagination/filter/search queries

### Phase 3 — R2 and image pipeline

- uploads
- metadata
- Cloudflare Images transformations
- responsive images
- lazy loading
- error handling

### Phase 4 — Admin security and CRUD

- Cloudflare Access
- admin routes
- add/edit/draft/publish/sold/hide/archive
- duplicate
- image ordering

### Phase 5 — Public product experience

- real catalog
- product detail
- filters
- Load More
- related items
- Facebook CTA

### Phase 6 — SEO, performance, accessibility

- metadata
- sitemap
- structured data
- performance tuning
- accessibility review

### Phase 7 — Testing and launch hardening

- browser/device testing
- E2E tests
- backup/recovery test
- preview deployment review
- security review
- launch checklist

### Phase 8 — Production launch

- domain
- DNS
- SSL
- production bindings
- admin access test
- analytics
- monitoring/usage alerts

---

## 39. Definition of Done for V1

V1 is not complete merely because pages render.

The project is launch-ready when all of the following are true:

- owner can manage normal product lifecycle without developer help
- no code editing is required to add/edit products
- admin access is protected
- public visitors cannot mutate data
- images are served responsively and efficiently
- initial catalog does not load all products/images at once
- mobile storefront is polished on iPhone Safari
- desktop/tablet layouts are verified
- core admin workflow works on mobile and desktop
- important loading/error/empty states exist
- SEO basics are implemented
- build/typecheck/tests pass
- production secrets are not in GitHub
- D1 recovery path is documented and tested
- production deployment can be reproduced from the GitHub repository
- preview workflow works before merging changes
- owner has successfully completed a real test: add product → preview → publish → mark sold

---

## 40. Decisions Frozen for V1

Unless there is a concrete implementation blocker, treat the following as fixed:

- Custom-built catalog rather than Shopify V1
- No direct checkout in V1
- Cloudflare-first infrastructure
- React Router v8 + TypeScript + Vite
- Cloudflare Workers for full-stack runtime
- D1 for catalog data
- R2 for original product imagery
- Cloudflare Images transformations for responsive delivery
- Cloudflare Access for admin authentication
- GitHub private repository as source of truth
- GitHub-driven preview/production deployment
- Load More pagination, 24 products per batch initially
- Soft-delete/archive lifecycle
- Mobile-first design
- Shopify-quality admin UX goal without copying Shopify UI
- Infrastructure target near $0/month at current scale

---

## 41. Open Business Inputs — Not Architecture Blockers

These can be supplied later without blocking project setup:

- final brand name
- logo files
- brand colours
- preferred typeface direction
- Facebook page/profile URL
- first real product set
- exact material vocabulary
- exact product categories beyond defaults
- contact information
- domain name
- legal copy

Use clearly labeled demo placeholders until real business content is provided.

---

**End of V1 specification.**
