# Jewelry Catalog Platform — Design Brief

**Status:** V2 visual direction after human design review  
**Applies to:** Public storefront first  
**Related specification:** `PROJECT_SPEC.md`

---

## 1. Purpose

This document defines the visual and interaction direction for the public
jewelry storefront.

`PROJECT_SPEC.md` remains authoritative for product requirements,
architecture, responsiveness, accessibility, performance, and scope.

This document is authoritative for storefront visual direction.

The V2 direction replaces the earlier overly editorial / presentation-like
interpretation.

---

## 2. Brand Context

The current assortment is broad and intentionally eclectic.

It includes products such as:

- delicate necklaces and anklets
- earrings
- Cuban and statement chains
- crystal / iced jewelry
- body chains
- grillz and tooth jewelry
- face jewelry
- playful and unusual fashion accessories

The brand should not be forced into a traditional fine-jewelry identity.

The variety is part of the personality.

The storefront should feel appropriate for someone who might buy a delicate
anklet one day and grillz or a body chain the next.

---

## 3. Core Direction

The intended direction is:

**Contemporary fashion retail with soft-dark urban / glam energy and a playful
edge.**

Approximate balance:

- 45% contemporary fashion retail
- 30% urban / nightlife
- 15% clean editorial
- 10% playful / unexpected

The site should feel:

- young
- fashion-forward
- confident
- image-heavy
- slightly rebellious
- a little sexy
- polished
- playful without being childish
- dark in moments, but not a fully dark website
- gender-inclusive

A useful personality phrase is:

**Playful rebellion with a clean retail shell.**

---

## 4. Retail First

The storefront must feel like somewhere to browse jewelry.

It should not feel like:

- a PowerPoint presentation
- a brand strategy deck
- a design agency portfolio
- a fashion manifesto
- a SaaS landing page

The visual rhythm should prioritize:

**products / imagery → discovery → products / imagery**

rather than:

**headline → explanation → headline → explanation**

The majority of the page should be visual merchandising rather than brand copy.

Target roughly:

- 80% visual / discovery / merchandising
- 20% brand messaging

---

## 5. Avoid

Avoid:

- traditional fine-jewelry luxury
- bridal styling
- overly feminine pink boutique styling
- black-and-gold luxury clichés
- full-site gothic styling
- ornate typography
- excessive serif usage
- generic SaaS cards
- giant presentation headlines on every section
- repeated eyebrow + headline + paragraph patterns
- manifesto-style copy
- large empty text-only sections
- excessive horizontal divider lines
- symmetrical presentation-deck compositions
- glassmorphism
- excessive gradients
- excessive rounded cards
- excessive shadows
- decorative animation

Do not make every section feel like a separate presentation slide.

---

## 6. Color Direction

Use a soft-dark system rather than a fully dark theme.

### Base light surface

Warm bone / ivory.

Suggested starting range:

- `#F3F0EA`
- nearby warm neutrals may be adjusted during implementation

### Primary dark

Ink / charcoal rather than pure black.

Suggested starting range:

- `#111111`
- `#171717`

### Secondary neutrals

Use subdued greys and metallic-inspired silver tones.

Possible direction:

- muted chrome
- cool silver-grey
- warm grey borders

### Accent

Use accent color very sparingly.

Preferred provisional direction:

**deep oxblood / wine**

Example starting point:

- `#681C29`

The accent should appear in small details only.

Do not make gold the dominant interface color.

Jewelry photography should provide most gold, silver, crystal, skin-tone, and
fashion color.

All exact values remain design tokens and must be easy to revise when the final
logo is available.

---

## 7. Light / Dark Rhythm

Do not make the entire storefront dark.

Use contrast between sections.

Example rhythm:

- light header
- strong photographic hero
- light product/discovery area
- one dark editorial / statement section
- return to light merchandising
- restrained footer

Dark sections should feel intentional and energetic.

They should provide contrast rather than become the entire identity.

---

## 8. Typography

Use the existing system sans-serif direction for now.

No external font dependency is required yet.

Typography should feel like fashion retail rather than a presentation deck.

Use:

- tighter headline proportions
- strong but controlled weight
- compact navigation
- smaller supporting copy
- product-oriented typography
- short labels
- occasional uppercase only where useful

Avoid using huge bold headlines repeatedly.

Avoid putting letter-spaced uppercase eyebrow text above every section.

Not every section needs a headline.

Visual hierarchy should often come from imagery and layout rather than type
alone.

---

## 9. Photography

Photography is the dominant source of personality.

Use:

- large editorial crops
- full-bleed imagery where appropriate
- model / lifestyle imagery
- close jewelry details
- occasional product-focused still life
- deliberate mixed image sizes

The existing product source imagery is inconsistent, so the UI must create
order without forcing every photograph into the same aesthetic.

Do not stretch images.

Use `object-fit` deliberately.

Product cards will eventually follow the 1:1 requirements in
`PROJECT_SPEC.md`, but editorial imagery does not need to be square.

Temporary licensed imagery may be used during design review but must be clearly
separated from actual catalog inventory.

---

## 10. Header

The header should feel like fashion retail, not a portfolio website.

Direction:

- compact height
- strong logo / wordmark position
- minimal chrome
- simple navigation
- generous touch targets

The logo itself should act as the route back to Home.

Do not show a redundant `Home` navigation item in the final storefront unless
there is a strong usability reason.

Human visual QA found that the temporary wordmark was not clearly recognized
as a Home link. Retain an explicit `Home` item for the current phase; reconsider
it after the final logo and brand identity are introduced.

Only expose navigation destinations that actually exist.

Until the real logo arrives, use a clearly temporary wordmark.

Do not invent a final brand name or logo.

---

## 11. Hero

The hero should be image-led rather than a 50/50 presentation split.

Preferred direction:

- photography dominates the viewport
- text may overlay photography or sit in a deliberately asymmetric composition
- headline is concise
- supporting copy is minimal
- one clear Shop CTA

Avoid:

- large empty text panels
- presentation-style left text / right rectangle compositions
- multiple explanatory paragraphs

The hero should immediately communicate:

**fashion + jewelry + attitude**

---

## 12. Merchandising Rhythm

After the hero, users should quickly encounter visual discovery.

Appropriate structures include:

- featured looks
- new / current visual direction
- shop by mood
- shop by style
- collection tiles
- category imagery
- editorial pairings

For Issue #2 these remain static visual shells.

Do not invent:

- fake products
- fake prices
- fake stock
- fake SKUs
- fake product counts

Temporary imagery may demonstrate merchandising layout without pretending to
be real inventory.

---

## 13. Category / Discovery Tiles

Prefer image-led discovery tiles over text-only lists.

Possible future directions include:

- Everyday
- Statement
- Icy
- Body
- After Dark
- Unexpected

These are design-direction examples, not approved taxonomy.

Do not turn them into real catalog filters until catalog requirements are
implemented.

The important design principle is:

**discovery should feel visual and clickable.**

---

## 14. Product Presentation

When actual catalog functionality arrives, products should dominate the Shop
experience.

Product UI should be restrained.

Future cards should emphasize:

1. image
2. product name
3. price
4. availability where needed

Avoid surrounding products with heavy boxes or decorative UI.

The storefront should feel dense enough to browse, but never cluttered.

---

## 15. Home Page Direction

Preferred future home-page rhythm:

1. compact header
2. strong image-led hero
3. immediate visual discovery / merchandising
4. featured looks or styles
5. one high-contrast dark section
6. more product/discovery imagery
7. short brand positioning
8. footer

Brand copy should be brief.

Do not create multiple manifesto sections.

---

## 16. Shop Page Direction

The Shop page should immediately read as a catalog destination.

Even before real data exists, its shell should establish:

- clear Shop title
- future filter / sort region where appropriate
- visually credible grid area
- restrained supporting copy
- strong retail density

Avoid giant empty whitespace.

Avoid making the Shop route look like another marketing presentation.

Do not fabricate inventory to fill it.

---

## 17. Buttons and Controls

Controls should feel compact and modern.

Use:

- restrained radius
- clear contrast
- visible focus
- immediate pressed / hover feedback
- adequate touch size

Primary buttons may use dark ink surfaces on light sections.

Dark sections may reverse this treatment.

Avoid pills everywhere.

Avoid decorative gradients.

---

## 18. Motion

Motion should remain restrained.

Useful:

- hover feedback
- image hover transitions
- navigation disclosure
- subtle press states

Avoid:

- dramatic page entrances
- scroll theatrics
- decorative parallax
- long animation sequences

Respect reduced motion.

---

## 19. Responsive Personality

Mobile is the primary experience.

Mobile should feel like a fashion shopping site, not a stacked desktop
presentation.

Priorities:

- imagery stays visually dominant
- navigation stays compact
- text becomes shorter rather than merely smaller
- discovery sections remain easy to scan
- touch targets remain comfortable
- no horizontal overflow
- no hover dependency

Desktop may use asymmetry and larger imagery.

Wide screens must retain disciplined max widths and composition.

---

## 20. Current Unknowns

Still provisional:

- final public brand name
- final logo
- final accent color
- final font pairing
- final product photography standards
- final taxonomy
- marketing copy

These unknowns should remain easy to replace.

Do not make architecture depend on provisional branding.

---

## 21. Decision Principle

When choosing between:

**more copy / more layout explanation**

and:

**more jewelry / more imagery / more browsing**

prefer the second.

When choosing between:

**perfect symmetry**

and:

**controlled fashion-oriented asymmetry**

prefer the second where usability remains clear.

When choosing between:

**traditional luxury**

and:

**younger contemporary character**

prefer the second.

The storefront should feel like a real place to discover unusual jewelry.