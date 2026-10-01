export const imageProfiles = {
  thumb: { width: 160, quality: 75 },
  card: { width: 640, quality: 80 },
  detail: { width: 1200, quality: 85 },
  zoom: { width: 2000, quality: 88 },
} as const;

export type ImageProfile = keyof typeof imageProfiles;

export function isImageProfile(value: string): value is ImageProfile {
  return Object.hasOwn(imageProfiles, value);
}
