import type {
  Category,
  Product,
  ProductImage,
  ProductStatus,
  PublicProductCard,
} from "./catalog-types";

export interface CategoryRow {
  id: number;
  name: string;
  slug: string;
  sort_order: number;
  is_active: number;
}

export interface ProductRow {
  id: number;
  name: string;
  slug: string;
  sku: string | null;
  description: string | null;
  price_cents: number;
  category_id: number;
  material: string | null;
  colour: string | null;
  status: string;
  quantity: number | null;
  facebook_url: string | null;
  created_at: number;
  updated_at: number;
  published_at: number | null;
  sort_order: number | null;
}

export interface ProductImageRow {
  id: number;
  product_id: number;
  r2_key: string;
  alt_text: string | null;
  sort_order: number;
  width: number | null;
  height: number | null;
  created_at: number;
}

export interface PublicProductCardRow {
  id: number;
  name: string;
  slug: string;
  price_cents: number;
  status: string;
  category_id: number;
  material: string | null;
  colour: string | null;
  created_at: number;
  cover_id: number | null;
  cover_r2_key: string | null;
  cover_alt_text: string | null;
  cover_sort_order: number | null;
  cover_width: number | null;
  cover_height: number | null;
  cover_created_at: number | null;
}

const statuses: readonly ProductStatus[] = [
  "draft",
  "available",
  "sold",
  "hidden",
  "archived",
];

function productStatus(value: string): ProductStatus {
  if (!statuses.includes(value as ProductStatus)) {
    throw new Error(`Unexpected product status: ${value}`);
  }
  return value as ProductStatus;
}

export function mapCategory(row: CategoryRow): Category {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    sortOrder: row.sort_order,
    isActive: row.is_active === 1,
  };
}

export function mapProduct(row: ProductRow): Product {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    sku: row.sku,
    description: row.description,
    priceCents: row.price_cents,
    categoryId: row.category_id,
    material: row.material,
    colour: row.colour,
    status: productStatus(row.status),
    quantity: row.quantity,
    facebookUrl: row.facebook_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    sortOrder: row.sort_order,
  };
}

export function mapProductImage(row: ProductImageRow): ProductImage {
  return {
    id: row.id,
    productId: row.product_id,
    r2Key: row.r2_key,
    altText: row.alt_text,
    sortOrder: row.sort_order,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
  };
}

export function mapPublicProductCard(
  row: PublicProductCardRow,
): PublicProductCard {
  const status = productStatus(row.status);
  if (status !== "available" && status !== "sold") {
    throw new Error(`Non-public product in public result: ${status}`);
  }

  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    priceCents: row.price_cents,
    status,
    categoryId: row.category_id,
    material: row.material,
    colour: row.colour,
    createdAt: row.created_at,
    coverImage:
      row.cover_id === null
        ? null
        : mapProductImage({
            id: row.cover_id,
            product_id: row.id,
            r2_key: row.cover_r2_key!,
            alt_text: row.cover_alt_text,
            sort_order: row.cover_sort_order!,
            width: row.cover_width,
            height: row.cover_height,
            created_at: row.cover_created_at!,
          }),
  };
}
