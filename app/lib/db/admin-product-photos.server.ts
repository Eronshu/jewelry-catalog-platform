import { AdminProductError } from "./admin-products.server";
import {
  boundedPhotoBody,
  inspectStoredPhoto,
  maxPhotoBytes,
  sniffPhoto,
  type PhotoFormat,
} from "../images/product-upload.server";
import { imageKeyContentType } from "../images/product-image.server";

export interface AdminPhoto {
  id: number;
  altText: string;
  sortOrder: number;
  width: number | null;
  height: number | null;
}
export interface AdminPhotoSnapshot {
  version: number;
  businessVersion: number;
  photos: AdminPhoto[];
}
export class PhotoMutationError extends AdminProductError {
  constructor(
    message: string,
    status: number,
    public code:
      "stale_product" | "upload_in_progress" | "upload_identity_conflict",
  ) {
    super(message, status);
  }
}
type ImageRow = {
  id: number;
  alt_text: string | null;
  sort_order: number;
  width: number | null;
  height: number | null;
};
type UploadRow = {
  upload_id: string;
  product_id: number;
  r2_key: string;
  sha256: string;
  byte_length: number;
  content_type: string;
  state: string;
  committed_version: number | null;
  writer_token: string;
  lease_until: number;
};
const noStore = { "Cache-Control": "private, no-store" };
const uploadLeaseMs = 5_000;
const uploadHeartbeatMs = 1_500;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digestPattern = /^[0-9a-f]{64}$/;

export function parsePhotoId(value: string | undefined): number {
  const id = Number(value);
  if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(id))
    throw new AdminProductError("Photo not found.", 404);
  return id;
}
export async function listAdminPhotos(
  db: D1Database,
  productId: number,
): Promise<AdminPhoto[]> {
  const rows = await db
    .prepare(
      "SELECT id, alt_text, sort_order, width, height FROM product_images WHERE product_id = ? ORDER BY sort_order, id",
    )
    .bind(productId)
    .all<ImageRow>();
  return rows.results.map((row) => ({
    id: row.id,
    altText: row.alt_text ?? "",
    sortOrder: row.sort_order,
    width: row.width,
    height: row.height,
  }));
}
export async function readAdminPhotoSnapshot(
  db: D1Database,
  productId: number,
): Promise<AdminPhotoSnapshot> {
  const [productResult, photoResult] = await db.batch([
    db
      .prepare(
        "SELECT updated_at, business_updated_at FROM products WHERE id = ?",
      )
      .bind(productId),
    db
      .prepare(
        "SELECT id, alt_text, sort_order, width, height FROM product_images WHERE product_id = ? ORDER BY sort_order, id",
      )
      .bind(productId),
  ]);
  const product = productResult.results[0] as
    { updated_at: number; business_updated_at: number } | undefined;
  if (!product) throw new AdminProductError("Product not found.", 404);
  return {
    version: product.updated_at,
    businessVersion: product.business_updated_at,
    photos: (photoResult.results as ImageRow[]).map((row) => ({
      id: row.id,
      altText: row.alt_text ?? "",
      sortOrder: row.sort_order,
      width: row.width,
      height: row.height,
    })),
  };
}
export async function adminPhotoSource(
  db: D1Database,
  productId: number,
  imageId: number,
): Promise<string | null> {
  const row = await db
    .prepare(
      "SELECT r2_key FROM product_images WHERE product_id = ? AND id = ?",
    )
    .bind(productId, imageId)
    .first<{ r2_key: string }>();
  return row?.r2_key ?? null;
}
async function productVersion(db: D1Database, id: number) {
  const row = await db
    .prepare("SELECT updated_at, status FROM products WHERE id = ?")
    .bind(id)
    .first<{ updated_at: number; status: string }>();
  if (!row) throw new AdminProductError("Product not found.", 404);
  return row;
}
function nextVersion(old: number): number {
  return Math.max(Date.now(), old + 1);
}
function guardedProduct(
  db: D1Database,
  id: number,
  version: number,
  token: string,
  condition = "1 = 1",
  values: (number | string)[] = [],
) {
  return db
    .prepare(
      `UPDATE products SET updated_at = ?, photo_mutation_token = ? WHERE id = ? AND updated_at = ? AND status != 'archived' AND ${condition} RETURNING updated_at`,
    )
    .bind(nextVersion(version), token, id, version, ...values);
}
function tokenCondition() {
  return "EXISTS (SELECT 1 FROM products p WHERE p.id = ? AND p.photo_mutation_token = ?)";
}
function resultVersion(batch: D1Result[], expected: number): number {
  if (batch[0].meta.changes !== 1)
    throw new PhotoMutationError(
      "This product changed. Refresh photos and try again.",
      409,
      "stale_product",
    );
  for (let i = 1; i < batch.length; i++)
    if (batch[i].meta.changes !== expected)
      throw new AdminProductError(
        "Photos changed. Refresh and try again.",
        409,
      );
  const value = (batch[0].results[0] as { updated_at?: number } | undefined)
    ?.updated_at;
  if (!Number.isSafeInteger(value))
    throw new AdminProductError(
      "Could not confirm this photo change. Refresh and try again.",
      503,
    );
  return value!;
}

export async function reorderPhotos(
  db: D1Database,
  productId: number,
  version: number,
  ids: number[],
) {
  if (
    ids.length < 1 ||
    ids.length > 100 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !Number.isSafeInteger(id) || id < 1)
  )
    throw new AdminProductError("Refresh photos and try again.", 400);
  const current = await listAdminPhotos(db, productId);
  if (
    current.length !== ids.length ||
    current.some((photo) => !ids.includes(photo.id))
  )
    throw new AdminProductError("Photos changed. Refresh and try again.", 409);
  const token = crypto.randomUUID();
  const placeholders = ids.map(() => "?").join(",");
  const max = Math.max(...current.map((p) => p.sortOrder));
  if (max > Number.MAX_SAFE_INTEGER - ids.length - 1)
    throw new AdminProductError("Refresh photos and try again.", 409);
  const staging = ids
    .map((id, index) => `WHEN ${id} THEN ${max + index + 1}`)
    .join(" ");
  const finalOrder = ids
    .map((id, index) => `WHEN ${id} THEN ${index}`)
    .join(" ");
  const batch = await db.batch([
    guardedProduct(
      db,
      productId,
      version,
      token,
      `(SELECT COUNT(*) FROM product_images WHERE product_id = ?) = ? AND NOT EXISTS (SELECT 1 FROM product_images WHERE product_id = ? AND id NOT IN (${placeholders}))`,
      [productId, ids.length, productId, ...ids],
    ),
    db
      .prepare(
        `UPDATE product_images SET sort_order = CASE id ${staging} END WHERE product_id = ? AND id IN (${placeholders}) AND ${tokenCondition()}`,
      )
      .bind(productId, ...ids, productId, token),
    db
      .prepare(
        `UPDATE product_images SET sort_order = CASE id ${finalOrder} END WHERE product_id = ? AND id IN (${placeholders}) AND ${tokenCondition()}`,
      )
      .bind(productId, ...ids, productId, token),
  ]);
  resultVersion(batch, ids.length);
  return readAdminPhotoSnapshot(db, productId);
}

export async function editPhotoAlt(
  db: D1Database,
  productId: number,
  imageId: number,
  version: number,
  raw: string,
) {
  const alt = raw.trim();
  if (!alt || alt.length > 240)
    throw new AdminProductError(
      "Describe this photo in 240 characters or fewer.",
    );
  const token = crypto.randomUUID();
  const batch = await db.batch([
    guardedProduct(
      db,
      productId,
      version,
      token,
      "EXISTS (SELECT 1 FROM product_images WHERE product_id = ? AND id = ?)",
      [productId, imageId],
    ),
    db
      .prepare(
        `UPDATE product_images SET alt_text = ? WHERE product_id = ? AND id = ? AND ${tokenCondition()}`,
      )
      .bind(alt, productId, imageId, productId, token),
  ]);
  resultVersion(batch, 1);
  return readAdminPhotoSnapshot(db, productId);
}

export async function removePhoto(
  env: Env,
  productId: number,
  imageId: number,
  version: number,
) {
  const db = env.DB;
  const source = await adminPhotoSource(db, productId, imageId);
  if (!source) throw new AdminProductError("Photo not found.", 404);
  const token = crypto.randomUUID();
  let batch: D1Result[];
  try {
    batch = await db.batch([
      guardedProduct(
        db,
        productId,
        version,
        token,
        "EXISTS (SELECT 1 FROM product_images WHERE product_id = ? AND id = ?) AND (status NOT IN ('available', 'sold') OR (SELECT COUNT(*) FROM product_images WHERE product_id = ?) > 1)",
        [productId, imageId, productId],
      ),
      db
        .prepare(
          `UPDATE product_photo_uploads SET state = 'removed' WHERE upload_id = (SELECT upload_id FROM product_images WHERE product_id = ? AND id = ?) AND ${tokenCondition()}`,
        )
        .bind(productId, imageId, productId, token),
      db
        .prepare(
          `DELETE FROM product_images WHERE product_id = ? AND id = ? AND ${tokenCondition()}`,
        )
        .bind(productId, imageId, productId, token),
    ]);
  } catch {
    throw new AdminProductError("Could not remove this photo. Try again.", 503);
  }
  if (batch[0].meta.changes !== 1)
    throw new AdminProductError(
      "This product changed, or this is its last public photo. Refresh and try again.",
      409,
    );
  if (batch[2].meta.changes !== 1)
    throw new AdminProductError("Photos changed. Refresh and try again.", 409);
  const stillReferenced = await db
    .prepare("SELECT 1 AS found FROM product_images WHERE r2_key = ?")
    .bind(source)
    .first();
  if (!stillReferenced) {
    try {
      await env.PRODUCT_IMAGES.delete(source);
    } catch {
      console.error("Removed photo requires R2 cleanup", {
        productId,
        imageId,
      });
    }
  }
  return readAdminPhotoSnapshot(db, productId);
}

function compareHex(actual: ArrayBuffer, expected: string) {
  const hex = Array.from(new Uint8Array(actual), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return hex === expected;
}
async function verifiedRetryBody(
  request: Request,
  expected: UploadRow,
  declaredLength: number | null,
) {
  const { body } = await boundedPhotoBody(request);
  const bytes = await new Response(body).arrayBuffer();
  if (declaredLength !== null && bytes.byteLength !== declaredLength)
    throw new AdminProductError(
      "This photo's upload was incomplete. Retry it.",
      400,
    );
  if (
    bytes.byteLength !== expected.byte_length ||
    !compareHex(await crypto.subtle.digest("SHA-256", bytes), expected.sha256)
  )
    throw new PhotoMutationError(
      "This upload belongs to a different file. Select it again.",
      409,
      "upload_identity_conflict",
    );
  return new Uint8Array(bytes);
}
function uploadInProgress() {
  return new PhotoMutationError(
    "This photo is still uploading. Retry in about five seconds.",
    409,
    "upload_in_progress",
  );
}
async function releaseUploadLease(
  db: D1Database,
  uploadId: string,
  writerToken: string,
) {
  await db
    .prepare(
      "UPDATE product_photo_uploads SET lease_until = 0 WHERE upload_id = ? AND writer_token = ? AND state = 'active'",
    )
    .bind(uploadId, writerToken)
    .run();
}
async function putOriginal(
  env: Env,
  uploadId: string,
  writerToken: string,
  key: string,
  bytes: Uint8Array,
  sha256: string,
  contentType: PhotoFormat["contentType"],
): Promise<R2Object> {
  let renewal = Promise.resolve();
  const heartbeat = setInterval(() => {
    renewal = renewal
      .then(async () => {
        await env.DB.prepare(
          "UPDATE product_photo_uploads SET lease_until = ? WHERE upload_id = ? AND writer_token = ? AND state = 'active'",
        )
          .bind(Date.now() + uploadLeaseMs, uploadId, writerToken)
          .run();
      })
      .catch(() => {
        /* A failed renewal permits guarded takeover. */
      });
  }, uploadHeartbeatMs);
  try {
    const object = await env.PRODUCT_IMAGES.put(key, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256,
      httpMetadata: { contentType },
    });
    if (object) return object;
    // Another identical writer may have won the immutable conditional put.
    const winner = await env.PRODUCT_IMAGES.head(key);
    if (winner) return winner;
    throw new Error("The original write did not complete");
  } catch (error) {
    console.error("Photo R2 write failed", error);
    clearInterval(heartbeat);
    try {
      await renewal;
      await releaseUploadLease(env.DB, uploadId, writerToken);
    } catch {
      console.error("Photo upload lease release failed");
    }
    throw new AdminProductError("Upload failed. Retry this photo.", 503);
  } finally {
    clearInterval(heartbeat);
  }
}
async function abandonInvalidOwnedUpload(
  env: Env,
  uploadId: string,
  productId: number,
  key: string,
  writerToken: string | null,
) {
  if (!writerToken) return;
  const db = env.DB;
  const terminal = await db
    .prepare(
      "UPDATE product_photo_uploads SET state = 'abandoned' WHERE upload_id = ? AND product_id = ? AND r2_key = ? AND writer_token = ? AND state = 'active' AND NOT EXISTS (SELECT 1 FROM product_images WHERE upload_id = ? OR r2_key = ?)",
    )
    .bind(uploadId, productId, key, writerToken, uploadId, key)
    .run();
  if (terminal.meta.changes !== 1) return;
  const referenced = await db
    .prepare(
      "SELECT 1 AS found FROM product_images WHERE upload_id = ? OR r2_key = ?",
    )
    .bind(uploadId, key)
    .first();
  if (referenced) return;
  try {
    await env.PRODUCT_IMAGES.delete(key);
  } catch {
    console.error("Invalid upload requires R2 cleanup", { productId });
  }
  // A writer that was already in R2 may finish after this delete. The terminal
  // reservation bars its D1 insert; reconcileAbandonedUpload removes its object.
}
function parseUploadHeaders(request: Request) {
  const uploadId = request.headers.get("X-Upload-Id") ?? "";
  const sha256 = request.headers.get("X-Photo-Sha256") ?? "";
  const version = Number(request.headers.get("X-Product-Version"));
  const declared = request.headers.get("Content-Length");
  const size =
    declared === null ? null : /^\d+$/.test(declared) ? Number(declared) : NaN;
  const type = request.headers.get("Content-Type") ?? "";
  if (
    !uuid.test(uploadId) ||
    !digestPattern.test(sha256) ||
    !Number.isSafeInteger(version) ||
    version < 0
  )
    throw new AdminProductError(
      "Refresh this page and try uploading again.",
      400,
    );
  if (size !== null && !Number.isSafeInteger(size))
    throw new AdminProductError(
      "This photo's upload could not be read. Select it again.",
      400,
    );
  if (size !== null && size > maxPhotoBytes)
    throw new AdminProductError(
      "This photo is too large. Choose one under 18 MB.",
      413,
    );
  if (!["image/jpeg", "image/png", "image/webp"].includes(type))
    throw new AdminProductError(
      "Choose a JPEG, PNG, or still WebP photo. HEIC and HEIF are not supported yet.",
      415,
    );
  return { uploadId, sha256, version, size, type };
}
export async function uploadPhoto(
  env: Env,
  productId: number,
  request: Request,
) {
  const db = env.DB;
  const headers = parseUploadHeaders(request);
  const existing = await db
    .prepare("SELECT * FROM product_photo_uploads WHERE upload_id = ?")
    .bind(headers.uploadId)
    .first<UploadRow>();
  let retryBytes: Uint8Array | null = null;
  if (existing) {
    if (
      existing.product_id !== productId ||
      existing.sha256 !== headers.sha256 ||
      existing.content_type !== headers.type ||
      existing.state === "removed" ||
      existing.state === "abandoned"
    )
      throw new PhotoMutationError(
        "This upload belongs to a different file. Select it again.",
        409,
        "upload_identity_conflict",
      );
    retryBytes = await verifiedRetryBody(request, existing, headers.size);
    const saved = await db
      .prepare(
        "SELECT id FROM product_images WHERE upload_id = ? AND product_id = ?",
      )
      .bind(headers.uploadId, productId)
      .first<{ id: number }>();
    if (saved) return readAdminPhotoSnapshot(db, productId);
  }
  const current = await productVersion(db, productId);
  if (current.status === "archived")
    throw new AdminProductError(
      "Restore this product before adding photos.",
      409,
    );
  if (current.updated_at !== headers.version)
    throw new PhotoMutationError(
      "This product changed. Refresh photos and try again.",
      409,
      "stale_product",
    );
  const photoCount = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM product_images WHERE product_id = ?",
    )
    .bind(productId)
    .first<{ count: number }>();
  if ((photoCount?.count ?? 0) >= 100)
    throw new AdminProductError(
      "This product has reached its 100-photo limit.",
      400,
    );
  let format: PhotoFormat;
  let key: string;
  let object: R2Object | null;
  let originalBytes: Uint8Array;
  let ownedWriterToken: string | null = null;
  if (existing) {
    originalBytes = retryBytes!;
    key = existing.r2_key;
    format = {
      contentType: existing.content_type as PhotoFormat["contentType"],
      extension: key.endsWith(".png")
        ? "png"
        : key.endsWith(".webp")
          ? "webp"
          : "jpg",
    };
    object = await env.PRODUCT_IMAGES.head(key);
    if (!object) {
      if (existing.lease_until >= Date.now()) throw uploadInProgress();
      ownedWriterToken = crypto.randomUUID();
      const claimed = await db
        .prepare(
          "UPDATE product_photo_uploads SET lease_until = ?, writer_token = ? WHERE upload_id = ? AND state = 'active' AND lease_until < ? AND NOT EXISTS (SELECT 1 FROM product_images WHERE upload_id = ?)",
        )
        .bind(
          Date.now() + uploadLeaseMs,
          ownedWriterToken,
          headers.uploadId,
          Date.now(),
          headers.uploadId,
        )
        .run();
      if (claimed.meta.changes !== 1) throw uploadInProgress();
      object = await putOriginal(
        env,
        headers.uploadId,
        ownedWriterToken,
        key,
        retryBytes!,
        headers.sha256,
        format.contentType,
      );
    }
  } else {
    const { prefix, body } = await boundedPhotoBody(request);
    format = sniffPhoto(prefix);
    if (format.contentType !== headers.type)
      throw new AdminProductError(
        "This photo's format does not match its file type.",
        415,
      );
    originalBytes = new Uint8Array(await new Response(body).arrayBuffer());
    if (headers.size !== null && originalBytes.length !== headers.size)
      throw new AdminProductError(
        "This photo's upload was incomplete. Select it again.",
        400,
      );
    if (
      !compareHex(
        await crypto.subtle.digest("SHA-256", Uint8Array.from(originalBytes)),
        headers.sha256,
      )
    )
      throw new AdminProductError(
        "This photo changed during upload. Choose it again.",
        400,
      );
    key = `products/${productId}/${headers.uploadId}.${format.extension}`;
    const now = Date.now();
    ownedWriterToken = crypto.randomUUID();
    const reserved = await db
      .prepare(
        "INSERT OR IGNORE INTO product_photo_uploads (upload_id, product_id, r2_key, sha256, byte_length, content_type, state, writer_token, created_at, lease_until) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)",
      )
      .bind(
        headers.uploadId,
        productId,
        key,
        headers.sha256,
        originalBytes.length,
        format.contentType,
        ownedWriterToken,
        now,
        now + uploadLeaseMs,
      )
      .run();
    if (reserved.meta.changes !== 1) throw uploadInProgress();
    object = await putOriginal(
      env,
      headers.uploadId,
      ownedWriterToken,
      key,
      originalBytes,
      headers.sha256,
      format.contentType,
    );
    if (!object || object.size !== originalBytes.length)
      throw new AdminProductError("Upload failed. Retry this photo.", 503);
  }
  if (
    !object ||
    object.size !== originalBytes.length ||
    object.httpMetadata?.contentType !== format.contentType
  )
    throw new AdminProductError("Could not check this photo. Retry it.", 503);
  if (
    object.checksums?.sha256 &&
    !compareHex(object.checksums.sha256, headers.sha256)
  )
    throw new AdminProductError("Could not check this photo. Retry it.", 503);
  let dimensions;
  try {
    dimensions = await inspectStoredPhoto(env, originalBytes, format);
  } catch (error) {
    await abandonInvalidOwnedUpload(
      env,
      headers.uploadId,
      productId,
      key,
      ownedWriterToken,
    );
    throw error;
  }
  const token = crypto.randomUUID();
  const batch = await db.batch([
    guardedProduct(
      db,
      productId,
      headers.version,
      token,
      "status != 'archived' AND (SELECT COUNT(*) FROM product_images WHERE product_id = ?) < 100 AND EXISTS (SELECT 1 FROM product_photo_uploads WHERE upload_id = ? AND product_id = ? AND state = 'active') AND NOT EXISTS (SELECT 1 FROM product_images WHERE upload_id = ?)",
      [productId, headers.uploadId, productId, headers.uploadId],
    ),
    db
      .prepare(
        `INSERT INTO product_images (product_id, r2_key, alt_text, sort_order, width, height, created_at, upload_id)
      SELECT ?, ?, NULL, COALESCE((SELECT MAX(sort_order) + 1 FROM product_images WHERE product_id = ?), 0), ?, ?, ?, ? WHERE ${tokenCondition()}`,
      )
      .bind(
        productId,
        key,
        productId,
        dimensions.width,
        dimensions.height,
        Date.now(),
        headers.uploadId,
        productId,
        token,
      ),
    db
      .prepare(
        `UPDATE product_photo_uploads SET state = 'committed', committed_version = (SELECT updated_at FROM products WHERE id = ? AND photo_mutation_token = ?) WHERE upload_id = ? AND state = 'active' AND ${tokenCondition()}`,
      )
      .bind(productId, token, headers.uploadId, productId, token),
  ]);
  resultVersion(batch, 1);
  return readAdminPhotoSnapshot(db, productId);
}

export async function findStaleUploads(db: D1Database, olderThan: number) {
  return db
    .prepare(
      "SELECT upload_id, product_id, r2_key FROM product_photo_uploads WHERE state = 'active' AND lease_until < ? LIMIT 100",
    )
    .bind(olderThan)
    .all<{ upload_id: string; product_id: number; r2_key: string }>();
}
export async function abandonStaleUpload(
  env: Env,
  uploadId: string,
  now = Date.now(),
) {
  const db = env.DB;
  const result = await db
    .prepare(
      "UPDATE product_photo_uploads SET state = 'abandoned' WHERE upload_id = ? AND state = 'active' AND lease_until < ? AND NOT EXISTS (SELECT 1 FROM product_images WHERE upload_id = ?)",
    )
    .bind(uploadId, now, uploadId)
    .run();
  if (result.meta.changes !== 1) return false;
  const row = await db
    .prepare(
      "SELECT r2_key FROM product_photo_uploads WHERE upload_id = ? AND state = 'abandoned'",
    )
    .bind(uploadId)
    .first<{ r2_key: string }>();
  if (
    !row ||
    !imageKeyContentType(row.r2_key, Number(row.r2_key.split("/")[1]))
  )
    return false;
  const ref = await db
    .prepare("SELECT 1 AS found FROM product_images WHERE r2_key = ?")
    .bind(row.r2_key)
    .first();
  if (!ref) await env.PRODUCT_IMAGES.delete(row.r2_key);
  return true;
}
export async function reconcileAbandonedUpload(
  env: Env,
  uploadId: string,
  now = Date.now(),
) {
  const row = await env.DB.prepare(
    "SELECT product_id, r2_key FROM product_photo_uploads WHERE upload_id = ? AND state = 'abandoned' AND lease_until < ?",
  )
    .bind(uploadId, now - 15 * 60_000)
    .first<{ product_id: number; r2_key: string }>();
  if (!row || !imageKeyContentType(row.r2_key, row.product_id)) return false;
  const reference = await env.DB.prepare(
    "SELECT 1 AS found FROM product_images WHERE r2_key = ?",
  )
    .bind(row.r2_key)
    .first();
  if (reference) return false;
  await env.PRODUCT_IMAGES.delete(row.r2_key);
  return true;
}
export async function reconcileRemovedUpload(env: Env, uploadId: string) {
  const row = await env.DB.prepare(
    "SELECT product_id, r2_key FROM product_photo_uploads WHERE upload_id = ? AND state = 'removed'",
  )
    .bind(uploadId)
    .first<{ product_id: number; r2_key: string }>();
  if (!row || !imageKeyContentType(row.r2_key, row.product_id)) return false;
  const reference = await env.DB.prepare(
    "SELECT 1 AS found FROM product_images WHERE r2_key = ?",
  )
    .bind(row.r2_key)
    .first();
  if (reference) return false;
  await env.PRODUCT_IMAGES.delete(row.r2_key);
  return true;
}
export { noStore };
