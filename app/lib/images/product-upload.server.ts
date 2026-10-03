import { AdminProductError } from "../db/admin-products.server";

export const maxPhotoBytes = 18_000_000;
const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export type PhotoFormat = {
  contentType: "image/jpeg" | "image/png" | "image/webp";
  extension: "jpg" | "png" | "webp";
};

export function sniffPhoto(bytes: Uint8Array): PhotoFormat {
  if (bytes.length >= 12 && signature.every((b, i) => bytes[i] === b))
    return { contentType: "image/png", extension: "png" };
  if (
    bytes.length >= 3 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255
  )
    return { contentType: "image/jpeg", extension: "jpg" };
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 12) === "WEBP"
  )
    return { contentType: "image/webp", extension: "webp" };
  throw new AdminProductError(
    "Choose a JPEG, PNG, or still WebP photo. HEIC and HEIF are not supported yet.",
    415,
  );
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}
function u32le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}
function u32be(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
}

export function rejectAnimation(bytes: Uint8Array, format: PhotoFormat): void {
  if (format.extension === "webp") {
    if (bytes.length < 20 || u32le(bytes, 4) + 8 !== bytes.length)
      throw new AdminProductError(
        "We couldn't read this photo. Choose another file.",
      );
    let position = 12;
    while (position + 8 <= bytes.length) {
      const name = ascii(bytes, position, position + 4);
      const size = u32le(bytes, position + 4);
      const next = position + 8 + size + (size & 1);
      if (next > bytes.length)
        throw new AdminProductError(
          "We couldn't read this photo. Choose another file.",
        );
      if (
        name === "ANIM" ||
        name === "ANMF" ||
        (name === "VP8X" && size >= 1 && (bytes[position + 8] & 2) !== 0)
      )
        throw new AdminProductError(
          "Choose a still photo. Animated photos aren't supported.",
        );
      position = next;
    }
    if (position !== bytes.length)
      throw new AdminProductError(
        "We couldn't read this photo. Choose another file.",
      );
  }
  if (format.extension === "png") {
    let position = 8;
    let ended = false;
    while (position + 12 <= bytes.length) {
      const size = u32be(bytes, position);
      const next = position + 12 + size;
      if (next > bytes.length)
        throw new AdminProductError(
          "We couldn't read this photo. Choose another file.",
        );
      let crc = 0xffffffff;
      for (let i = position + 4; i < position + 8 + size; i++)
        crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
      if ((crc ^ 0xffffffff) >>> 0 !== u32be(bytes, position + 8 + size))
        throw new AdminProductError(
          "We couldn't read this photo. Choose another file.",
        );
      const name = ascii(bytes, position + 4, position + 8);
      if (name === "acTL")
        throw new AdminProductError(
          "Choose a still photo. Animated photos aren't supported.",
        );
      if (name === "IEND") {
        ended = true;
        if (next !== bytes.length)
          throw new AdminProductError(
            "We couldn't read this photo. Choose another file.",
          );
      }
      position = next;
    }
    if (!ended || position !== bytes.length)
      throw new AdminProductError(
        "We couldn't read this photo. Choose another file.",
      );
  }
}

export async function inspectStoredPhoto(
  env: Pick<Env, "IMAGES">,
  bytes: Uint8Array,
  expected: PhotoFormat,
) {
  if (bytes.length < 1 || bytes.length > maxPhotoBytes)
    throw new AdminProductError(
      "This photo is too large. Choose one under 18 MB.",
      413,
    );
  const actual = sniffPhoto(bytes);
  if (actual.contentType !== expected.contentType)
    throw new AdminProductError(
      "This photo's format changed. Choose it again.",
      415,
    );
  rejectAnimation(bytes, actual);
  let info: ImageInfoResponse;
  try {
    info = await env.IMAGES.info(new Blob([Uint8Array.from(bytes)]).stream());
  } catch {
    throw new AdminProductError(
      "We couldn't read this photo. Choose another file.",
    );
  }
  if (
    !("width" in info) ||
    info.format !== expected.contentType ||
    !Number.isSafeInteger(info.width) ||
    !Number.isSafeInteger(info.height) ||
    info.width < 1 ||
    info.height < 1 ||
    info.width > 12_000 ||
    info.height > 12_000 ||
    info.width * info.height > 40_000_000
  )
    throw new AdminProductError(
      "This photo's dimensions aren't supported. Choose another file.",
    );
  try {
    const transformed = await env.IMAGES.input(
      new Blob([Uint8Array.from(bytes)]).stream(),
    )
      .transform({ width: 1, fit: "scale-down" })
      .output({ format: "image/webp" });
    const response = transformed.response();
    if (!response.ok) throw new Error("Decode failed");
    await response.arrayBuffer();
  } catch {
    throw new AdminProductError(
      "We couldn't read this photo. Choose another file.",
    );
  }
  return { width: info.width, height: info.height };
}

export async function boundedPhotoBody(
  request: Request,
): Promise<{ prefix: Uint8Array; body: ReadableStream<Uint8Array> }> {
  const reader = request.body?.getReader();
  if (!reader) throw new AdminProductError("Choose a photo to upload.");
  const initial: Uint8Array[] = [];
  let size = 0;
  while (size < 16) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.length;
    if (size > maxPhotoBytes) {
      await reader.cancel();
      throw new AdminProductError(
        "This photo is too large. Choose one under 18 MB.",
        413,
      );
    }
    initial.push(next.value);
  }
  if (!size) throw new AdminProductError("This photo is empty.");
  const prefix = new Uint8Array(Math.min(size, 16));
  let copied = 0;
  for (const chunk of initial) {
    const count = Math.min(chunk.length, prefix.length - copied);
    prefix.set(chunk.subarray(0, count), copied);
    copied += count;
    if (copied === prefix.length) break;
  }
  let initialIndex = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (initialIndex < initial.length) {
        controller.enqueue(initial[initialIndex++]);
        return;
      }
      const next = await reader.read();
      if (next.done) {
        controller.close();
        return;
      }
      size += next.value.length;
      if (size > maxPhotoBytes) {
        await reader.cancel();
        controller.error(
          new AdminProductError(
            "This photo is too large. Choose one under 18 MB.",
            413,
          ),
        );
        return;
      }
      controller.enqueue(next.value);
    },
    cancel() {
      return reader.cancel();
    },
  });
  return { prefix, body };
}
