export type ProductStatus =
  "draft" | "available" | "sold" | "hidden" | "archived";

export interface Category {
  id: number;
  name: string;
  slug: string;
  sortOrder: number;
  isActive: boolean;
}

export interface Product {
  id: number;
  name: string;
  slug: string;
  sku: string | null;
  description: string | null;
  priceCents: number;
  categoryId: number;
  material: string | null;
  colour: string | null;
  status: ProductStatus;
  quantity: number | null;
  facebookUrl: string | null;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
  sortOrder: number | null;
}

export interface ProductImage {
  id: number;
  productId: number;
  r2Key: string;
  altText: string | null;
  sortOrder: number;
  width: number | null;
  height: number | null;
  createdAt: number;
}

export interface PublicProductCard {
  id: number;
  name: string;
  slug: string;
  priceCents: number;
  status: "available" | "sold";
  categoryId: number;
  material: string | null;
  colour: string | null;
  createdAt: number;
  coverImage: ProductImage | null;
}

export interface ProductWithImages {
  product: Product;
  images: ProductImage[];
}
