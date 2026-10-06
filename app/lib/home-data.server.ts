import { listPublicProducts } from "./db/products.server";
import { toShopPageCard } from "./shop-data.server";

export async function homeData(db: D1Database) {
  const products = await listPublicProducts(db, { limit: 4, sort: "newest" });

  return {
    products: products.map(toShopPageCard),
  };
}
