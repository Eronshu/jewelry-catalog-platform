import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { deflateSync } from "node:zlib";

// A small synthetic checker image, generated locally without product imagery.
const path = resolve(".wrangler/fixtures/fictional-checker.png");
const width = 64;
const height = 64;

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function chunk(type, body) {
  const name = Buffer.from(type);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([name, body])) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, name, body, checksum]);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(width, 0);
header.writeUInt32BE(height, 4);
header[8] = 8;
header[9] = 2;

const pixels = Buffer.alloc(height * (1 + width * 3));
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const offset = y * (1 + width * 3) + 1 + x * 3;
    const dark = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0;
    pixels[offset] = dark ? 32 : 220;
    pixels[offset + 1] = dark ? 42 : 205;
    pixels[offset + 2] = dark ? 56 : 185;
  }
}

mkdirSync(dirname(path), { recursive: true });
writeFileSync(
  path,
  Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]),
);
process.stdout.write(`${path}\n`);
