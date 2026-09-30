import { mapCategory, type CategoryRow } from "./catalog-mappers";
import type { Category } from "./catalog-types";

export async function listActiveCategories(
  db: D1Database,
): Promise<Category[]> {
  const result = await db
    .prepare(
      `SELECT id, name, slug, sort_order, is_active
       FROM categories
       WHERE is_active = 1
       ORDER BY sort_order ASC, id ASC`,
    )
    .all<CategoryRow>();

  return result.results.map(mapCategory);
}
