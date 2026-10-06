export type ShopSort = "newest" | "price-asc" | "price-desc";
export const MAX_SHOP_BATCHES = 20;

export interface ShopFilters {
  q: string;
  category: string;
  material: string;
  colour: string;
  availability: "" | "available" | "sold";
  sort: ShopSort;
}

export interface ShopQuery {
  filters: ShopFilters;
  batches: number;
  after: string;
  canonical: string;
  invalid: boolean;
}

const keys = [
  "q",
  "category",
  "material",
  "colour",
  "availability",
  "sort",
  "batches",
  "after",
] as const;

export function shopUrl(
  filters: ShopFilters,
  extras: { batches?: number; after?: string } = {},
) {
  const params = new URLSearchParams();
  for (const key of [
    "q",
    "category",
    "material",
    "colour",
    "availability",
  ] as const) {
    if (filters[key]) params.set(key, filters[key]);
  }
  if (filters.sort !== "newest") params.set("sort", filters.sort);
  if (extras.batches && extras.batches > 1)
    params.set("batches", String(extras.batches));
  if (extras.after) params.set("after", extras.after);
  return `/shop${params.size ? `?${params}` : ""}`;
}

export function parseShopQuery(url: URL): ShopQuery {
  if (url.search.length > 2048) throw new Response(null, { status: 414 });
  const params = url.searchParams;
  let invalid = [...params.keys()].some(
    (key) => !keys.includes(key as (typeof keys)[number]),
  );
  function value(key: (typeof keys)[number], max: number) {
    const all = params.getAll(key);
    if (all.length > 1) invalid = true;
    if (all.length !== 1) return "";
    const trimmed = all[0].trim();
    if (Array.from(trimmed).length > max || !trimmed || trimmed !== all[0]) {
      invalid = true;
      return "";
    }
    return trimmed;
  }
  const q = value("q", 100);
  const category = value("category", 80);
  const material = value("material", 80).toLowerCase();
  const colour = value("colour", 80).toLowerCase();
  const availabilityValue = value("availability", 16);
  const sortValue = value("sort", 16);
  const batchesValue = value("batches", 2);
  const afterValue = value("after", 1024);
  if (category && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(category)) invalid = true;
  const filters: ShopFilters = {
    q,
    category: /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(category) ? category : "",
    material,
    colour,
    availability:
      availabilityValue === "available" || availabilityValue === "sold"
        ? availabilityValue
        : "",
    sort:
      sortValue === "price-asc" || sortValue === "price-desc"
        ? sortValue
        : "newest",
  };
  if (availabilityValue && !filters.availability) invalid = true;
  if (sortValue && sortValue !== filters.sort) invalid = true;
  const batches =
    /^(?:[2-9]|1\d|20)$/.test(batchesValue) &&
    Number(batchesValue) <= MAX_SHOP_BATCHES
      ? Number(batchesValue)
      : 1;
  if (batchesValue && batches === 1) invalid = true;
  const after = /^[A-Za-z0-9_-]+$/.test(afterValue) ? afterValue : "";
  if (afterValue && !after) invalid = true;
  if (after && batchesValue) invalid = true;
  const canonical = shopUrl(filters, after ? { after } : { batches });
  return {
    filters,
    batches,
    after,
    canonical,
    invalid: invalid || url.pathname + url.search !== canonical,
  };
}
