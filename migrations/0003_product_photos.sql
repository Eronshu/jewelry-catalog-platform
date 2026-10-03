ALTER TABLE products ADD COLUMN photo_mutation_token TEXT;
ALTER TABLE products ADD COLUMN business_updated_at INTEGER NOT NULL DEFAULT 0;
UPDATE products SET business_updated_at = updated_at;

CREATE TABLE product_photo_uploads (
  upload_id TEXT PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 18000000),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  state TEXT NOT NULL CHECK (state IN ('active', 'committed', 'abandoned', 'removed')),
  committed_version INTEGER,
  writer_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL
);

CREATE INDEX idx_product_photo_uploads_cleanup
  ON product_photo_uploads (state, lease_until);

ALTER TABLE product_images ADD COLUMN upload_id TEXT REFERENCES product_photo_uploads(upload_id);
CREATE UNIQUE INDEX idx_product_images_upload_id
  ON product_images (upload_id) WHERE upload_id IS NOT NULL;
