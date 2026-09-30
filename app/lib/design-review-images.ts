/**
 * Temporary Unsplash photography for storefront design review only.
 * These are editorial images, not catalog products or owned brand assets.
 * Replace or remove before production launch.
 */
const unsplashImage = (photoId: string, width: number) =>
  `https://images.unsplash.com/${photoId}?auto=format&fit=crop&w=${width}&q=78`;

function reviewImage(photoId: string) {
  return {
    src: unsplashImage(photoId, 1200),
    srcSet: [640, 960, 1200, 1600]
      .map((width) => `${unsplashImage(photoId, width)} ${width}w`)
      .join(", "),
  };
}

export const reviewImages = {
  hero: {
    ...reviewImage("photo-1770643661899-bf150b61789e"),
    alt: "Close-up of a woman wearing a delicate gold necklace",
    source:
      "https://unsplash.com/photos/close-up-of-a-woman-wearing-a-delicate-gold-necklace-buMSS1tcrjA",
  },
  urban: {
    ...reviewImage("photo-1573273256429-b4cd0434fb96"),
    alt: "Woman wearing a gold-colored Cuban-chain necklace",
    source: "https://unsplash.com/photos/bovelgYUj0M",
  },
  body: {
    ...reviewImage("photo-1763130782823-346bba485ec9"),
    alt: "Woman wearing a belly chain with charms",
    source:
      "https://unsplash.com/photos/woman-wearing-a-belly-chain-with-charms-IvQvwuKTBkw",
  },
  bracelet: {
    ...reviewImage("photo-1602173574767-37ac01994b2a"),
    alt: "Gold chain bracelet resting on a magazine",
    source:
      "https://unsplash.com/photos/a-gold-chain-bracelet-sitting-on-top-of-a-magazine-oO0JAOJhquk",
  },
} as const;
