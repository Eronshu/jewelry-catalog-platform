import { reviewImages } from "./design-review-images";

/**
 * Temporary visual-density fixture for Issue #2 design review only.
 * These photographs are not the owner's product images, the labels are style
 * descriptors rather than inventory records, and prices are intentionally unset.
 * Retained for Home's design preview while Shop uses the real catalog.
 */
function unsplashPhoto(photoId: string, alt: string, source: string) {
  const imageUrl = (width: number) =>
    `https://images.unsplash.com/${photoId}?auto=format&fit=crop&w=${width}&q=72`;

  return {
    alt,
    source,
    src: imageUrl(640),
    srcSet: [320, 480, 640, 960]
      .map((width) => `${imageUrl(width)} ${width}w`)
      .join(", "),
  };
}

const photos = {
  ...reviewImages,
  grillz: unsplashPhoto(
    "photo-1760724820412-0dfd70dab608",
    "Woman wearing gold grillz and a furry hat",
    "https://unsplash.com/photos/woman-with-furry-hat-and-gold-grillz-SbKr8gkc_X8",
  ),
  streetGrillz: unsplashPhoto(
    "photo-1774029533454-2c820cdef3c7",
    "Man in a fur hood wearing sunglasses and grillz",
    "https://unsplash.com/photos/man-in-fur-hood-with-sunglasses-and-grillz-grills-R0Cz-m1a6tA",
  ),
  toothGems: unsplashPhoto(
    "photo-1578057287201-3812f175e204",
    "Close view of tooth gems",
    "https://unsplash.com/photos/shallow-focus-photo-of-persons-teeth-Abck-EjJUjM",
  ),
  silverEarrings: unsplashPhoto(
    "photo-1583262428949-7d9f74ca3657",
    "Woman wearing silver earrings",
    "https://unsplash.com/photos/woman-in-white-scoop-neck-shirt-wearing-silver-earrings-Ia6SXz0oh_U",
  ),
  blueEarrings: unsplashPhoto(
    "photo-1535632066927-ab7c9ab60908",
    "Silver earrings with blue gemstones",
    "https://unsplash.com/photos/pair-of-silver-colored-earrings-with-blue-gemstone-VJZdxfvFGuo",
  ),
  sparkleEarrings: unsplashPhoto(
    "photo-1714700513036-558227ceabc4",
    "Close view of a person wearing sparkling earrings",
    "https://unsplash.com/photos/a-close-up-of-a-person-wearing-a-pair-of-earrings-uqol_kiM3vQ",
  ),
  silverChain: unsplashPhoto(
    "photo-1623699654653-5f03c0168a6a",
    "Person wearing a silver chain necklace",
    "https://unsplash.com/photos/person-wearing-silver-chain-necklace-_v7M3y2i3bU",
  ),
  darkNecklace: unsplashPhoto(
    "photo-1612011213611-ff46ab689475",
    "Silver necklace photographed against a dark background",
    "https://unsplash.com/photos/silver-chain-necklace-on-black-textile-2t7MhIxLMWU",
  ),
  pendant: unsplashPhoto(
    "photo-1780565336234-0348cbdc3a24",
    "Gold pendant and chain worn over a dark shirt",
    "https://unsplash.com/photos/stylish-gold-chain-with-a-distinctive-hat-pendant-tQVE7oMHsXg",
  ),
  silverBracelet: unsplashPhoto(
    "photo-1596942699002-a7f234a5bb59",
    "Silver link bracelet on a tattooed wrist",
    "https://unsplash.com/photos/silver-chain-link-bracelet-9Ju0cUttWoQ",
  ),
  rings: unsplashPhoto(
    "photo-1573575154350-35e29dfd6cdc",
    "Gold rings beside an open book",
    "https://unsplash.com/photos/gold-colored-rings-near-open-book-mI82mfLu538",
  ),
  anklet: unsplashPhoto(
    "photo-1764420068424-9f28e8df9ca5",
    "Feet with an anklet and yellow toenails",
    "https://unsplash.com/photos/womans-feet-with-yellow-toenails-and-anklet-WN64Lq56gqY",
  ),
  chainAndEarrings: unsplashPhoto(
    "photo-1598462272091-86586f7e6a72",
    "Woman wearing a silver necklace and earrings",
    "https://unsplash.com/photos/woman-in-silver-necklace-and-silver-earrings-Olhj3nO9qxQ",
  ),
} as const;

export const shopDesignReviewCards = [
  { id: "01", label: "Gold grillz styling", image: photos.grillz },
  { id: "02", label: "Cuban chain styling", image: photos.urban },
  { id: "03", label: "Delicate necklace styling", image: photos.hero },
  { id: "04", label: "Statement earrings", image: photos.silverEarrings },
  { id: "05", label: "Body chain styling", image: photos.body },
  { id: "06", label: "Silver chain styling", image: photos.silverChain },
  { id: "07", label: "Tooth gem styling", image: photos.toothGems },
  { id: "08", label: "Gold bracelet styling", image: photos.bracelet },
  { id: "09", label: "Blue stone earrings", image: photos.blueEarrings },
  { id: "10", label: "Gold pendant styling", image: photos.pendant },
  { id: "11", label: "Link bracelet styling", image: photos.silverBracelet },
  { id: "12", label: "Anklet styling", image: photos.anklet },
  { id: "13", label: "Street grillz styling", image: photos.streetGrillz },
  { id: "14", label: "Gold ring styling", image: photos.rings },
  { id: "15", label: "Sparkle earrings", image: photos.sparkleEarrings },
  { id: "16", label: "Dark silver necklace", image: photos.darkNecklace },
  { id: "17", label: "Silver jewelry layers", image: photos.chainAndEarrings },
  { id: "18", label: "Delicate pendant styling", image: photos.hero },
  { id: "19", label: "Body jewelry styling", image: photos.body },
  { id: "20", label: "Gold link styling", image: photos.bracelet },
  { id: "21", label: "Grillz close-up", image: photos.grillz },
  { id: "22", label: "Silver earring styling", image: photos.silverEarrings },
  { id: "23", label: "Chain necklace styling", image: photos.urban },
  { id: "24", label: "Anklet detail styling", image: photos.anklet },
] as const;
