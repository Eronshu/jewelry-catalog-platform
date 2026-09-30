/** Slug candidates for future authenticated product creation. Names never rewrite existing slugs. */
export function slugifyProductName(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "product"
  );
}

export function slugCandidate(base: string, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError("Slug attempt must be a positive integer.");
  }
  return attempt === 1 ? base : `${base}-${attempt}`;
}
