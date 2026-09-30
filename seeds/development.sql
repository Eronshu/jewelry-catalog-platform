-- Fictional local-development catalog only. Never apply this file remotely.
-- Image keys below are metadata placeholders; no R2 objects or product photos exist.
-- Fixed IDs and timestamps make clean local rebuilds reproducible.

WITH seed_products (id, name, slug, sku, price_cents, category_id, material, colour, day) AS (
  VALUES
    (1001, 'Demo Orbit Hoops', 'demo-orbit-hoops', 'DEMO-E01', 2800, 1, 'silver tone', 'silver', 0),
    (1002, 'Demo Electric Studs', 'demo-electric-studs', NULL, 1900, 1, 'stainless steel', 'silver', 1),
    (1003, 'Demo Prism Drops', 'demo-prism-drops', 'DEMO-E03', 2400, 1, 'acrylic', 'clear', 2),
    (1004, 'Demo Nightfall Tassels', 'demo-nightfall-tassels', NULL, 3600, 1, 'alloy', 'black', 3),
    (1005, 'Demo Petal Sparks', 'demo-petal-sparks', 'DEMO-E05', 2200, 1, 'resin', 'red', 4),
    (1006, 'Demo Lunar Loop Earrings', 'demo-lunar-loop-earrings', NULL, 3100, 1, 'mixed metal', 'gold', 5),
    (1007, 'Demo Satellite Chain', 'demo-satellite-chain', 'DEMO-N07', 4800, 2, 'stainless steel', 'silver', 6),
    (1008, 'Demo Ribbon Pendant', 'demo-ribbon-pendant', NULL, 4200, 2, 'alloy', 'gold', 7),
    (1009, 'Demo Blue Hour Beads', 'demo-blue-hour-beads', 'DEMO-N09', 3500, 2, 'glass', 'blue', 8),
    (1010, 'Demo Chrome Halo Necklace', 'demo-chrome-halo-necklace', NULL, 5900, 2, 'silver tone', 'silver', 9),
    (1011, 'Demo Afterlight Charm Chain', 'demo-afterlight-charm-chain', 'DEMO-N11', 6700, 2, 'mixed metal', 'multicolour', 10),
    (1012, 'Demo Velvet Comet Necklace', 'demo-velvet-comet-necklace', NULL, 5200, 2, 'alloy', 'black', 11),
    (1013, 'Demo Pulse Cuff', 'demo-pulse-cuff', 'DEMO-B13', 3900, 3, 'stainless steel', 'silver', 12),
    (1014, 'Demo Confetti Link Bracelet', 'demo-confetti-link-bracelet', NULL, 2600, 3, 'resin', 'multicolour', 13),
    (1015, 'Demo Mirage Bangle', 'demo-mirage-bangle', 'DEMO-B15', 4400, 3, 'gold tone', 'gold', 14),
    (1016, 'Demo Cloudline Bead Bracelet', 'demo-cloudline-bead-bracelet', NULL, 2100, 3, 'glass', 'white', 15),
    (1017, 'Demo Static Wave Bracelet', 'demo-static-wave-bracelet', 'DEMO-B17', 5500, 3, 'mixed metal', 'black', 16),
    (1018, 'Demo Studio Bracelet', 'demo-studio-bracelet', NULL, 3300, 3, 'alloy', 'blue', 17),
    (1019, 'Demo Orbit Band', 'demo-orbit-band', 'DEMO-R19', 2300, 4, 'stainless steel', 'silver', 18),
    (1020, 'Demo Nova Signet', 'demo-nova-signet', NULL, 4900, 4, 'alloy', 'gold', 19),
    (1021, 'Demo Candy Arc Ring', 'demo-candy-arc-ring', 'DEMO-R21', 1800, 4, 'resin', 'pink', 20),
    (1022, 'Demo Prism Stack Ring', 'demo-prism-stack-ring', NULL, 2700, 4, 'acrylic', 'clear', 21),
    (1023, 'Demo Midnight Grid Ring', 'demo-midnight-grid-ring', 'DEMO-R23', 3700, 4, 'mixed metal', 'black', 22),
    (1024, 'Demo Hidden Sample Ring', 'demo-hidden-sample-ring', NULL, 2500, 4, 'silver tone', 'silver', 23)
)
INSERT INTO products
  (id, name, slug, sku, description, price_cents, category_id, material,
   colour, status, created_at, updated_at)
SELECT id, name, slug, sku, 'Fictional local-development sample; not real inventory.',
       price_cents, category_id, material, colour, 'draft',
       1780000000000 + day * 86400000,
       1780000000000 + day * 86400000
FROM seed_products
WHERE true
ON CONFLICT(slug) DO NOTHING;

WITH seed_images (id, product_id, image_number, sort_order, alt_text, width, height) AS (
  VALUES
    (2001, 1001, 1, 0, 'Demo Orbit Hoops, front view', 1400, 1400),
    (2002, 1002, 1, 0, 'Demo Electric Studs, front view', 1400, 1400),
    (2003, 1003, 1, 0, 'Demo Prism Drops, front view', 1400, 1400),
    (2004, 1004, 1, 0, 'Demo Nightfall Tassels, front view', 1400, 1400),
    (2005, 1005, 1, 0, 'Demo Petal Sparks, front view', 1400, 1400),
    (2006, 1006, 1, 0, 'Demo Lunar Loop Earrings, front view', 1400, 1400),
    (2007, 1007, 1, 0, 'Demo Satellite Chain, front view', 1400, 1400),
    (2008, 1008, 1, 0, 'Demo Ribbon Pendant, front view', 1400, 1400),
    (2009, 1009, 1, 0, 'Demo Blue Hour Beads, front view', 1400, 1400),
    (2010, 1010, 1, 0, 'Demo Chrome Halo Necklace, front view', 1400, 1400),
    (2011, 1011, 1, 0, 'Demo Afterlight Charm Chain, front view', 1400, 1400),
    (2012, 1012, 1, 0, 'Demo Velvet Comet Necklace, front view', 1400, 1400),
    (2013, 1013, 1, 0, 'Demo Pulse Cuff, front view', 1400, 1400),
    (2014, 1014, 1, 0, 'Demo Confetti Link Bracelet, front view', 1400, 1400),
    (2015, 1015, 1, 0, 'Demo Mirage Bangle, front view', 1400, 1400),
    (2016, 1016, 1, 0, 'Demo Cloudline Bead Bracelet, front view', 1400, 1400),
    (2017, 1017, 1, 0, 'Demo Static Wave Bracelet, front view', 1400, 1400),
    (2018, 1019, 1, 0, 'Demo Orbit Band, front view', 1400, 1400),
    (2019, 1020, 1, 0, 'Demo Nova Signet, front view', 1400, 1400),
    (2020, 1021, 1, 0, 'Demo Candy Arc Ring, front view', 1400, 1400),
    (2021, 1022, 1, 0, 'Demo Prism Stack Ring, front view', 1400, 1400),
    (2022, 1023, 1, 0, 'Demo Midnight Grid Ring, front view', 1400, 1400),
    (2023, 1001, 2, 1, 'Demo Orbit Hoops, side view', 1600, 1200),
    (2024, 1001, 3, 2, 'Demo Orbit Hoops, detail view', 1800, 1400),
    (2025, 1003, 2, 1, 'Demo Prism Drops, detail view', 1800, 1400),
    (2026, 1007, 2, 1, 'Demo Satellite Chain, side view', 1600, 1200),
    (2027, 1007, 3, 2, 'Demo Satellite Chain, clasp detail', 1800, 1400),
    (2028, 1010, 2, 1, 'Demo Chrome Halo Necklace, detail view', 1800, 1400),
    (2029, 1013, 2, 1, 'Demo Pulse Cuff, side view', 1600, 1200),
    (2030, 1013, 3, 2, 'Demo Pulse Cuff, detail view', 1800, 1400),
    (2031, 1015, 2, 1, 'Demo Mirage Bangle, detail view', 1800, 1400),
    (2032, 1019, 2, 1, 'Demo Orbit Band, side view', 1600, 1200)
)
INSERT INTO product_images
  (id, product_id, r2_key, alt_text, sort_order, width, height, created_at)
SELECT i.id, i.product_id,
       'dev/products/' || p.slug || '/' || printf('%02d', i.image_number) || '.jpg',
       i.alt_text, i.sort_order, i.width, i.height, p.created_at
FROM seed_images i
JOIN products p ON p.id = i.product_id
WHERE true
ON CONFLICT(r2_key) DO NOTHING;

UPDATE products SET status = 'available', published_at = created_at
WHERE id IN (1001, 1002, 1003, 1004, 1005, 1007, 1008, 1009, 1010, 1011,
             1013, 1014, 1015, 1016, 1017, 1019, 1020, 1021, 1022, 1023);

UPDATE products SET status = 'sold', published_at = created_at
WHERE id IN (1006, 1012);

UPDATE products SET status = 'hidden' WHERE id = 1024;
