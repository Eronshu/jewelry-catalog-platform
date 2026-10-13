import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";

// Entirely fictional portfolio content. Generated files stay in ignored
// .wrangler/ state; never apply them to a real inventory database.
const output = resolve(".wrangler/portfolio-demo");
const firstProductId = 500001;
const firstImageId = 600001;
const publishedAt = Date.UTC(2026, 9, 1);
const categoryNames = ["Earrings", "Necklaces", "Bracelets", "Rings"];
const types = ["Hoops", "Pendant", "Bracelet", "Ring"];
const motifs = [
  "Orbit",
  "Solstice",
  "Ripple",
  "Arc",
  "Nova",
  "Petal",
  "Halo",
  "Drift",
  "Prism",
  "Muse",
  "Dawn",
  "Comet",
  "Tide",
  "Ember",
  "Contour",
];
const palettes = [
  {
    name: "Ivory",
    background: "#eee9dc",
    background2: "#ddd5c3",
    metal: "#c19b58",
    highlight: "#fff4cc",
    shadow: "#6e5632",
    stone: "#f8f0dc",
    colour: "cream",
  },
  {
    name: "Rose",
    background: "#f0e1df",
    background2: "#dec5c0",
    metal: "#b7827e",
    highlight: "#ffe9de",
    shadow: "#704442",
    stone: "#bd5d78",
    colour: "pink",
  },
  {
    name: "Sea",
    background: "#e0ebea",
    background2: "#c0d6d3",
    metal: "#a5aeb0",
    highlight: "#f6ffff",
    shadow: "#506d70",
    stone: "#2a9299",
    colour: "blue",
  },
  {
    name: "Amber",
    background: "#ede3d4",
    background2: "#d9c3a3",
    metal: "#b88b49",
    highlight: "#ffdf98",
    shadow: "#78542c",
    stone: "#c46b31",
    colour: "orange",
  },
  {
    name: "Noir",
    background: "#dcdad8",
    background2: "#b4b1ae",
    metal: "#565d64",
    highlight: "#e9e8e3",
    shadow: "#303439",
    stone: "#343741",
    colour: "black",
  },
];

function sql(value) {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  return "'" + value.replaceAll("'", "''") + "'";
}

function uuidFor(id) {
  const bytes = createHash("sha256")
    .update(`portfolio-demo-image-${id}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function gem(x, y, size, variant) {
  if (variant % 3 === 0)
    return `<circle cx="${x}" cy="${y}" r="${size}" fill="url(#stone)" stroke="url(#metal)" stroke-width="5"/>`;
  if (variant % 3 === 1)
    return `<rect x="${x - size}" y="${y - size}" width="${size * 2}" height="${size * 2}" rx="8" transform="rotate(45 ${x} ${y})" fill="url(#stone)" stroke="url(#metal)" stroke-width="5"/>`;
  return `<path d="M${x} ${y - size * 1.35} C${x + size * 1.2} ${y - size * 0.25} ${x + size} ${y + size * 0.8} ${x} ${y + size * 1.2} C${x - size} ${y + size * 0.8} ${x - size * 1.2} ${y - size * 0.25} ${x} ${y - size * 1.35}Z" fill="url(#stone)" stroke="url(#metal)" stroke-width="5"/>`;
}

function jewelry(category, variant) {
  const extra = variant % 5;
  if (category === 0) {
    const radius = 57 + extra * 5;
    return [230, 410]
      .map(
        (x) => `<g filter="url(#shadow)">
          <circle cx="${x}" cy="314" r="${radius}" fill="none" stroke="url(#metal)" stroke-width="20"/>
          <path d="M${x - 12} 213 Q${x} 192 ${x + 12} 213" fill="none" stroke="url(#metal)" stroke-width="12" stroke-linecap="round"/>
          <path d="M${x} ${314 + radius} L${x} ${404 + extra * 5}" stroke="url(#metal)" stroke-width="8"/>
          ${gem(x, 428 + extra * 5, 18 + (variant % 3) * 4, variant)}
        </g>`,
      )
      .join("");
  }
  if (category === 1)
    return `<g filter="url(#shadow)">
      <path d="M150 200 C165 440 470 440 490 200" fill="none" stroke="url(#metal)" stroke-width="${10 + extra * 2}" stroke-linecap="round"/>
      <path d="M174 244 C215 380 427 380 466 244" fill="none" stroke="url(#metal)" stroke-width="3" opacity=".7"/>
      ${gem(320, 399, 37 + extra * 3, variant)}
    </g>`;
  if (category === 2) {
    const beads = Array.from({ length: 12 }, (_, n) => {
      const angle = (n / 12) * Math.PI * 2;
      const x = Math.round(320 + (156 + extra * 3) * Math.cos(angle));
      const y = Math.round(325 + (86 + extra * 2) * Math.sin(angle));
      return gem(x, y, 9 + ((n + variant) % 3) * 2, variant + n);
    }).join("");
    return `<g filter="url(#shadow)">
      <ellipse cx="320" cy="325" rx="${156 + extra * 3}" ry="${86 + extra * 2}" fill="none" stroke="url(#metal)" stroke-width="16"/>
      ${beads}
      ${gem(320, 419, 24 + extra * 2, variant)}
    </g>`;
  }
  return `<g filter="url(#shadow)">
    <ellipse cx="320" cy="352" rx="${132 + extra * 3}" ry="${104 + extra * 3}" fill="none" stroke="url(#metal)" stroke-width="${33 + extra * 2}"/>
    <ellipse cx="320" cy="350" rx="${105 + extra * 3}" ry="${79 + extra * 3}" fill="none" stroke="var(--ring-inner, #ffffff)" stroke-opacity=".22" stroke-width="5"/>
    ${gem(320, 235, 41 + extra * 3, variant)}
  </g>`;
}

function imageSvg(category, variant, palette, number) {
  const tilt = ((variant % 7) - 3) * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640">
    <defs>
      <linearGradient id="back" x2=".9" y2="1">
        <stop stop-color="${palette.background}"/><stop offset="1" stop-color="${palette.background2}"/>
      </linearGradient>
      <linearGradient id="metal" x1="0" y1="0" x2="1" y2="1">
        <stop stop-color="${palette.shadow}"/><stop offset=".28" stop-color="${palette.highlight}"/>
        <stop offset=".58" stop-color="${palette.metal}"/><stop offset=".84" stop-color="${palette.highlight}"/>
        <stop offset="1" stop-color="${palette.shadow}"/>
      </linearGradient>
      <radialGradient id="stone"><stop stop-color="${palette.highlight}"/><stop offset=".62" stop-color="${palette.stone}"/><stop offset="1" stop-color="${palette.shadow}"/></radialGradient>
      <filter id="shadow" x="-40%" y="-40%" width="180%" height="180%">
        <feDropShadow dx="8" dy="15" stdDeviation="12" flood-color="${palette.shadow}" flood-opacity=".25"/>
      </filter>
    </defs>
    <rect width="640" height="640" fill="url(#back)"/>
    <circle cx="510" cy="95" r="200" fill="white" opacity=".13"/>
    <circle cx="110" cy="550" r="190" fill="white" opacity=".12"/>
    <ellipse cx="320" cy="498" rx="186" ry="21" fill="${palette.shadow}" opacity=".08"/>
    <g transform="rotate(${tilt} 320 320)">${jewelry(category, variant)}</g>
    <text x="320" y="568" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="17" letter-spacing="4" fill="${palette.shadow}" opacity=".72">PORTFOLIO CONCEPT</text>
    <text x="320" y="594" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="12" letter-spacing="3" fill="${palette.shadow}" opacity=".48">${String(number).padStart(3, "0")} · FICTIONAL JEWELRY</text>
  </svg>`;
}

const products = [];
const productRows = [];
const imageRows = [];
await mkdir(resolve(output, "images"), { recursive: true });

for (let category = 0; category < 4; category++) {
  for (let motif = 0; motif < motifs.length; motif++) {
    for (let paletteIndex = 0; paletteIndex < palettes.length; paletteIndex++) {
      const sequence = category * 75 + motif * 5 + paletteIndex;
      const id = firstProductId + sequence;
      const imageId = firstImageId + sequence;
      const variant = motif * palettes.length + paletteIndex;
      const palette = palettes[paletteIndex];
      const name = `Demo ${motifs[motif]} ${palette.name} ${types[category]}`;
      const slug = `demo-${motifs[motif].toLowerCase()}-${palette.name.toLowerCase()}-${types[category].toLowerCase()}-${id}`;
      const key = `products/${id}/${uuidFor(id)}.webp`;
      const file = `images/${id}.webp`;
      // Interleave categories in Newest, so the first Shop page and Home
      // feature row demonstrate the whole catalog rather than only Rings.
      const displayOrder =
        (motif * palettes.length + paletteIndex) * 4 + category;
      const created = publishedAt + displayOrder * 60_000;
      const price = 2800 + category * 1800 + motif * 250 + paletteIndex * 175;
      const description =
        `Fictional portfolio concept in the ${categoryNames[category].toLowerCase()} collection. ` +
        "Illustrated product image; price and availability are demonstrations only. This item is not for sale.";
      const fields = [
        id,
        name,
        slug,
        `DEMO-${String(id).slice(-5)}`,
        description,
        price,
        category + 1,
        "mixed metal",
        palette.colour,
        "draft",
        1,
        created,
        created,
        created,
        sequence,
        created,
      ];
      productRows.push(`  (${fields.map(sql).join(", ")})`);
      imageRows.push(
        `  (${[imageId, id, key, `Illustrated concept of ${name}`, 0, 640, 640, created].map(sql).join(", ")})`,
      );
      products.push({ id, imageId, name, slug, key, file, createdAt: created });
      await sharp(
        Buffer.from(imageSvg(category, variant, palette, sequence + 1)),
      )
        .webp({ quality: 84, effort: 4 })
        .toFile(resolve(output, file));
    }
  }
}

function insertBatches(table, columns, rows) {
  const statements = [];
  for (let offset = 0; offset < rows.length; offset += 15) {
    statements.push(
      `INSERT INTO ${table}
  (${columns})
VALUES
${rows.slice(offset, offset + 15).join(",\n")};`,
    );
  }
  return statements;
}

const seed = [
  "-- FICTIONAL portfolio catalog. Do not apply to production or real inventory.",
  "-- Generated by scripts/generate-portfolio-demo.mjs; paired R2 objects are required.",
  "-- Apply only to an empty, explicitly selected demo database after uploading all images.",
  ...insertBatches(
    "products",
    `id, name, slug, sku, description, price_cents, category_id, material, colour,
   status, quantity, created_at, updated_at, published_at, sort_order, business_updated_at`,
    productRows,
  ),
  ...insertBatches(
    "product_images",
    "id, product_id, r2_key, alt_text, sort_order, width, height, created_at",
    imageRows,
  ),
  `UPDATE products SET status = 'available'
WHERE id BETWEEN ${firstProductId} AND ${firstProductId + products.length - 1};`,
  "",
].join("\n\n");

await writeFile(resolve(output, "seed.sql"), seed);
const interleavedTime = `${publishedAt} + (((id - ${firstProductId}) % 75) * 4 + CAST((id - ${firstProductId}) / 75 AS INTEGER)) * 60000`;
await writeFile(
  resolve(output, "interleave-existing.sql"),
  [
    "-- One-time correction for an earlier portfolio seed with category-block timestamps.",
    "-- Exact fixed-range demo rows only. New imports already have this order.",
    `UPDATE products SET
  created_at = ${interleavedTime},
  updated_at = ${interleavedTime},
  published_at = ${interleavedTime},
  business_updated_at = ${interleavedTime}
WHERE id BETWEEN ${firstProductId} AND ${firstProductId + products.length - 1}
  AND slug LIKE 'demo-%' AND sku LIKE 'DEMO-%';`,
    `UPDATE product_images SET created_at = (
  SELECT products.created_at FROM products WHERE products.id = product_images.product_id
)
WHERE product_id BETWEEN ${firstProductId} AND ${firstProductId + products.length - 1}
  AND product_id IN (SELECT id FROM products WHERE slug LIKE 'demo-%' AND sku LIKE 'DEMO-%');`,
    "",
  ].join("\n\n"),
);
await writeFile(
  resolve(output, "rollback.sql"),
  [
    "-- Exact fictional portfolio ID range only. Review before remote use.",
    `UPDATE products SET status = 'draft', published_at = NULL
WHERE id BETWEEN ${firstProductId} AND ${firstProductId + products.length - 1}
  AND slug LIKE 'demo-%';`,
    `DELETE FROM product_images
WHERE product_id BETWEEN ${firstProductId} AND ${firstProductId + products.length - 1}
  AND product_id IN (SELECT id FROM products WHERE slug LIKE 'demo-%');`,
    `DELETE FROM products
WHERE id BETWEEN ${firstProductId} AND ${firstProductId + products.length - 1}
  AND slug LIKE 'demo-%';`,
    "",
  ].join("\n\n"),
);
await writeFile(
  resolve(output, "manifest.json"),
  JSON.stringify(
    {
      label: "Fictional portfolio demonstration; no real inventory",
      generatedBy: "scripts/generate-portfolio-demo.mjs",
      count: products.length,
      products,
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write(
  `Generated ${products.length} fictional products and images in ${output}\n`,
);
