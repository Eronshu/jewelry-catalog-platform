import { listActiveCategories } from "./db/categories.server";
import {
  listPublicFacets,
  listPublicProductPage,
  publicCatalogHasProducts,
  publicCursorAnchorMatches,
} from "./db/products.server";
import { productImageUrl } from "./images/image-urls";
import type { PublicProductCard } from "./db/catalog-types";
import { parseShopQuery, shopUrl, type ShopFilters } from "./shop-query";

export interface ShopPageCard {
  slug: string;
  name: string;
  priceCents: number;
  status: "available" | "sold";
  cover: { url: string; altText: string | null } | null;
}

export function toShopPageCard(product: PublicProductCard): ShopPageCard {
  return {
    slug: product.slug,
    name: product.name,
    priceCents: product.priceCents,
    status: product.status,
    cover: product.coverImage
      ? {
          url: productImageUrl(product.id, product.coverImage.id, "card"),
          altText: product.coverImage.altText,
        }
      : null,
  };
}

export interface ShopPage {
  products: ShopPageCard[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface ShopFullData {
  page: ShopPage;
  filters: ShopFilters;
  query: ReturnType<typeof parseShopQuery>;
  categories: { name: string; slug: string }[];
  facets: { materials: string[]; colours: string[] };
  emptyCatalog: boolean;
}

export interface ShopReset {
  resetUrl: string;
  stale: boolean;
}

function encodeCursor(filters: ShopFilters, key: number, id: number) {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ v: 1, filters, key, id }),
  );
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeCursor(value: string, filters: ShopFilters) {
  try {
    const encoded = value.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (!parsed || typeof parsed !== "object") return null;
    const cursor = parsed as {
      v?: unknown;
      filters?: unknown;
      key?: unknown;
      id?: unknown;
    };
    if (
      cursor.v !== 1 ||
      JSON.stringify(cursor.filters) !== JSON.stringify(filters) ||
      !Number.isSafeInteger(cursor.key) ||
      !Number.isSafeInteger(cursor.id) ||
      (cursor.key as number) < 0 ||
      (cursor.id as number) < 1
    )
      return null;
    return { key: cursor.key as number, id: cursor.id as number };
  } catch {
    return null;
  }
}

export function shopData(
  db: D1Database,
  requestUrl: URL,
): Promise<ShopFullData | ShopReset>;
export function shopData(
  db: D1Database,
  requestUrl: URL,
  resource: true,
): Promise<{ page: ShopPage } | ShopReset>;
export async function shopData(
  db: D1Database,
  requestUrl: URL,
  resource = false,
) {
  const shopRequestUrl = new URL(requestUrl);
  shopRequestUrl.pathname = "/shop";
  let query = parseShopQuery(shopRequestUrl);
  const categories = await listActiveCategories(db);
  if (
    query.filters.category &&
    !categories.some((category) => category.slug === query.filters.category)
  ) {
    const corrected = new URL(requestUrl);
    corrected.searchParams.delete("category");
    corrected.searchParams.delete("after");
    corrected.searchParams.delete("batches");
    query = parseShopQuery(
      new URL(shopUrl({ ...query.filters, category: "" }), corrected.origin),
    );
    return { resetUrl: query.canonical, stale: false } as const;
  }
  if (query.invalid)
    return { resetUrl: query.canonical, stale: false } as const;
  const filters = query.filters;
  const options = {
    categoryId: categories.find(
      (category) => category.slug === filters.category,
    )?.id,
    material: filters.material || undefined,
    colour: filters.colour || undefined,
    availability: filters.availability || undefined,
    q: filters.q || undefined,
    sort: filters.sort,
  };
  let pageCursor: { key: number; id: number } | undefined;
  if (query.after) {
    const decoded = decodeCursor(query.after, filters);
    if (
      !decoded ||
      !(await publicCursorAnchorMatches(
        db,
        decoded.id,
        decoded.key,
        filters.sort,
        options,
      ))
    ) {
      return { resetUrl: shopUrl(filters), stale: true } as const;
    }
    pageCursor = decoded;
  }
  const result = await listPublicProductPage(db, { ...options, pageCursor });
  const products: ShopPageCard[] = result.products.map(toShopPageCard);
  const last = result.products.at(-1);
  const nextCursor =
    result.hasMore && last
      ? encodeCursor(
          filters,
          filters.sort === "newest" ? last.createdAt : last.priceCents,
          last.id,
        )
      : null;
  const page: ShopPage = { products, hasMore: result.hasMore, nextCursor };
  if (resource) return { page };
  const facets = await listPublicFacets(db);
  const emptyCatalog =
    products.length === 0 && !query.after
      ? !(await publicCatalogHasProducts(db))
      : false;
  return {
    page,
    filters,
    query,
    categories: categories.map(({ name, slug }) => ({ name, slug })),
    facets,
    emptyCatalog,
  } as const;
}
