-- Fixture places. Codes are the real PSGC (10-digit, PH) and JIS X 0402 (JP) codes as far as known,
-- but the BOUNDARIES ARE STAND-INS: a 16-sided polygon around the approximate town centre with roughly the
-- real land area. The pipeline loads official PSA / MLIT boundaries; golden answers in the conformance suite
-- are computed against these stand-ins, not real geography. Areas and 2020 census populations are approximate.
WITH src (place_id, country, kind, name, name_ja, admin1, admin1_ja, admin2, population, area_km2, lon, lat) AS (
  VALUES
    ('PH-0831600000', 'PH', 'city',         'Tacloban City',  NULL,       'Eastern Visayas', NULL,     'Leyte',           251881, 201.72, 125.0039, 11.2433),
    ('PH-0802616000', 'PH', 'municipality', 'Guiuan',         NULL,       'Eastern Visayas', NULL,     'Eastern Samar',    53361, 175.62, 125.7247, 11.0333),
    ('PH-0803738000', 'PH', 'city',         'Ormoc City',     NULL,       'Eastern Visayas', NULL,     'Leyte',           230998, 613.60, 124.6075, 11.0064),
    ('PH-0502011000', 'PH', 'municipality', 'Virac',          NULL,       'Bicol Region',    NULL,     'Catanduanes',      76520, 145.30, 124.2306, 13.5800),
    ('PH-1380600000', 'PH', 'city',         'City of Manila', NULL,       'National Capital Region', NULL, NULL,          1846513,  42.88, 120.9842, 14.5995),
    ('JP-47201',      'JP', 'city',         'Naha',           '那覇市',   'Okinawa',         '沖縄県',  NULL,            317625,  41.42, 127.6809, 26.2124),
    ('JP-47207',      'JP', 'city',         'Ishigaki',       '石垣市',   'Okinawa',         '沖縄県',  NULL,             47637, 229.15, 124.1557, 24.3448),
    ('JP-46201',      'JP', 'city',         'Kagoshima',      '鹿児島市', 'Kagoshima',       '鹿児島県', NULL,           593128, 547.61, 130.5571, 31.5966),
    ('JP-27100',      'JP', 'city',         'Osaka',          '大阪市',   'Osaka',           '大阪府',  NULL,           2752412, 225.33, 135.5023, 34.6937),
    ('JP-13101',      'JP', 'special-ward', 'Chiyoda',        '千代田区', 'Tokyo',           '東京都',  NULL,             66680,  11.66, 139.7536, 35.6940)
),
shaped AS (
  SELECT s.*,
         ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography AS centroid,
         ST_Multi(ST_Buffer(ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography,
                            sqrt(area_km2 * 1e6 / pi()), 'quad_segs=4')::geometry) AS poly
  FROM src s
)
INSERT INTO catalog.place (place_id, country, kind, name, name_ja, admin1, admin1_ja, admin2, population, area_km2,
                           centroid, geom, geom_display, search_text)
SELECT place_id, country, kind, name, name_ja, admin1, admin1_ja, admin2, population, area_km2,
       centroid, poly::geography, ST_SnapToGrid(poly, 0.0001)::geography,
       lower(concat_ws(' | ', name, name_ja, admin1, admin1_ja, admin2))
FROM shaped;

-- Landfall place ids where a landfall point falls inside a fixture place.
UPDATE catalog.storm_landfall l SET place_id = p.place_id
FROM catalog.place p WHERE ST_Covers(p.geom, l.position);
