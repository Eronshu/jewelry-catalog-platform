CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  slug TEXT NOT NULL COLLATE NOCASE UNIQUE
    CHECK (length(slug) > 0 AND slug = lower(slug)
      AND slug NOT GLOB '*[^a-z0-9-]*'
      AND slug NOT LIKE '-%' AND slug NOT LIKE '%-'
      AND slug NOT LIKE '%--%'),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (typeof(sort_order) = 'integer'),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name, char(9, 10, 11, 12, 13, 32, 133, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0),
  slug TEXT NOT NULL COLLATE NOCASE UNIQUE
    CHECK (length(slug) > 0 AND slug = lower(slug)
      AND slug NOT GLOB '*[^a-z0-9-]*'
      AND slug NOT LIKE '-%' AND slug NOT LIKE '%-'
      AND slug NOT LIKE '%--%'),
  sku TEXT COLLATE NOCASE UNIQUE CHECK (sku IS NULL OR length(trim(sku)) > 0),
  description TEXT,
  price_cents INTEGER NOT NULL CHECK (typeof(price_cents) = 'integer' AND price_cents >= 0),
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  material TEXT CHECK (material IS NULL OR
    (length(material) > 0 AND material = lower(trim(material)))),
  colour TEXT CHECK (colour IS NULL OR
    (length(colour) > 0 AND colour = lower(trim(colour)))),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'available', 'sold', 'hidden', 'archived')),
  quantity INTEGER CHECK (quantity IS NULL OR (typeof(quantity) = 'integer' AND quantity >= 0)),
  facebook_url TEXT CHECK (facebook_url IS NULL OR length(trim(facebook_url)) > 0),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= created_at),
  published_at INTEGER CHECK (published_at IS NULL OR (typeof(published_at) = 'integer' AND published_at >= created_at)),
  sort_order INTEGER CHECK (sort_order IS NULL OR typeof(sort_order) = 'integer')
);

CREATE TABLE product_images (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL UNIQUE CHECK (length(trim(r2_key)) > 0),
  alt_text TEXT,
  sort_order INTEGER NOT NULL CHECK (typeof(sort_order) = 'integer' AND sort_order >= 0),
  width INTEGER CHECK (width IS NULL OR (typeof(width) = 'integer' AND width > 0)),
  height INTEGER CHECK (height IS NULL OR (typeof(height) = 'integer' AND height > 0)),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  UNIQUE (product_id, sort_order),
  CHECK ((width IS NULL) = (height IS NULL))
);

CREATE INDEX idx_products_public_newest
  ON products (created_at DESC, id DESC)
  WHERE status IN ('available', 'sold');

CREATE INDEX idx_products_public_category_newest
  ON products (category_id, created_at DESC, id DESC)
  WHERE status IN ('available', 'sold');

CREATE INDEX idx_products_status_updated
  ON products (status, updated_at DESC, id DESC);

CREATE TRIGGER products_require_image_on_insert
BEFORE INSERT ON products
WHEN NEW.status IN ('available', 'sold')
BEGIN
  SELECT RAISE(ABORT, 'public product requires an image');
END;

CREATE TRIGGER products_require_image_on_status_change
BEFORE UPDATE OF status ON products
WHEN NEW.status IN ('available', 'sold')
  AND NOT EXISTS (SELECT 1 FROM product_images WHERE product_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'public product requires an image');
END;

CREATE TRIGGER product_images_keep_last_public_image_on_delete
BEFORE DELETE ON product_images
WHEN (SELECT status FROM products WHERE id = OLD.product_id) IN ('available', 'sold')
  AND NOT EXISTS (
    SELECT 1 FROM product_images
    WHERE product_id = OLD.product_id AND id <> OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'public product requires an image');
END;

CREATE TRIGGER product_images_keep_last_public_image_on_move
BEFORE UPDATE OF product_id ON product_images
WHEN NEW.product_id <> OLD.product_id
  AND (SELECT status FROM products WHERE id = OLD.product_id) IN ('available', 'sold')
  AND NOT EXISTS (
    SELECT 1 FROM product_images
    WHERE product_id = OLD.product_id AND id <> OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'public product requires an image');
END;

-- REPLACE may delete conflicting image rows without firing DELETE triggers.
-- Check the resulting state after both INSERT OR REPLACE and UPDATE OR REPLACE.
CREATE TRIGGER product_images_verify_public_images_after_insert
AFTER INSERT ON product_images
WHEN EXISTS (
  SELECT 1 FROM products p
  WHERE p.status IN ('available', 'sold')
    AND NOT EXISTS (SELECT 1 FROM product_images i WHERE i.product_id = p.id)
)
BEGIN
  SELECT RAISE(ABORT, 'public product requires an image');
END;

CREATE TRIGGER product_images_verify_public_images_after_update
AFTER UPDATE ON product_images
WHEN EXISTS (
  SELECT 1 FROM products p
  WHERE p.status IN ('available', 'sold')
    AND NOT EXISTS (SELECT 1 FROM product_images i WHERE i.product_id = p.id)
)
BEGIN
  SELECT RAISE(ABORT, 'public product requires an image');
END;

INSERT INTO categories (id, name, slug, sort_order) VALUES
  (1, 'Earrings', 'earrings', 0),
  (2, 'Necklaces', 'necklaces', 1),
  (3, 'Bracelets', 'bracelets', 2),
  (4, 'Rings', 'rings', 3);
