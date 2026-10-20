-- migrate:up

-- Catalogue tables. No foreign keys between them on purpose: the pipeline swaps them one at a time
-- (CREATE TABLE catalog_next.x (LIKE catalog.x INCLUDING ALL) -> COPY -> rename), and validates
-- referential integrity itself before publishing a new dataset_version.

CREATE TABLE catalog.dataset_version (
  version         integer     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  published_at    timestamptz NOT NULL DEFAULT now(),
  ibtracs_version text        NOT NULL,
  source_commit   text,
  description     text
);
COMMENT ON TABLE catalog.dataset_version IS
  'One row per published catalogue load. The newest version is the {datasetVersion} in every catalogue ETag W/"d{v}-{resourceKey}", so inserting a row invalidates all of them.';

CREATE VIEW catalog.current_dataset_version AS
  SELECT version, published_at FROM catalog.dataset_version ORDER BY version DESC LIMIT 1;
COMMENT ON VIEW catalog.current_dataset_version IS 'The datasetVersion served in /v1/meta and catalogue ETags.';

CREATE TABLE catalog.storm (
  sid                   text        PRIMARY KEY CHECK (sid ~ '^[0-9]{7}[NS][0-9]{5}$'),
  season                smallint    NOT NULL CHECK (season BETWEEN 1840 AND 2100),
  basin                 text        NOT NULL CHECK (basin IN ('WP','EP','NA','NI','SI','SP','SA')),
  number                smallint,
  name                  text        NOT NULL,
  name_ibtracs          text        NOT NULL,
  name_ja               text,
  atcf_id               text,
  jma_number            smallint,
  track_type            text        NOT NULL DEFAULT 'main',
  started_at            timestamptz NOT NULL,
  ended_at              timestamptz NOT NULL,
  fix_count             smallint    NOT NULL CHECK (fix_count >= 0),
  peak_wind_kt          smallint,
  peak_wind_agency      text        CHECK (peak_wind_agency IN ('jma','jtwc','pagasa','wmo','cma','hko','kma')),
  peak_at               timestamptz,
  peak_position         geography(Point, 4326),
  min_pressure_hpa      smallint,
  jtwc_max_wind_kt      smallint,
  jtwc_min_pressure_hpa smallint,
  jma_max_wind_kt       smallint,
  jma_min_pressure_hpa  smallint,
  wmo_max_wind_kt       smallint,
  wmo_min_pressure_hpa  smallint,
  landfall_countries    text[]      NOT NULL DEFAULT '{}' CHECK (landfall_countries <@ ARRAY['PH','JP']),
  track                 geography(LineString, 4326),
  replay_available      boolean     NOT NULL DEFAULT false,
  search_text           text        NOT NULL DEFAULT '',
  CHECK (ended_at >= started_at)
);
COMMENT ON TABLE catalog.storm IS 'One row per IBTrACS storm (WP since 1940 in v1). Units: knots, hPa.';
COMMENT ON COLUMN catalog.storm.name IS 'International name in title case; ''Unnamed'' when IBTrACS has UNNAMED.';
COMMENT ON COLUMN catalog.storm.name_ibtracs IS 'Raw IBTrACS NAME (upper case, may contain '':'' for merged names).';
COMMENT ON COLUMN catalog.storm.name_ja IS 'JMA designation, e.g. 台風第30号 (served as localNames.ja).';
COMMENT ON COLUMN catalog.storm.peak_wind_kt IS 'Lifetime max sustained wind from peak_wind_agency: JTWC (1-min) preferred, else JMA, else WMO (10-min).';
COMMENT ON COLUMN catalog.storm.track IS 'Best-track LineString (geography edges are geodesic, so dateline crossings need no unwrapping), used by GET /v1/hits for arbitrary points.';
COMMENT ON COLUMN catalog.storm.search_text IS 'Lower-cased names joined by '' | '': international, IBTrACS, PAGASA, Japanese. Filled by the pipeline; matched by ?q=.';

CREATE INDEX storm_season_sid_idx    ON catalog.storm (season DESC, sid);
CREATE INDEX storm_peak_wind_idx     ON catalog.storm ((coalesce(peak_wind_kt, -1)) DESC, sid);
CREATE INDEX storm_name_idx          ON catalog.storm (upper(name) COLLATE "C", sid);
CREATE INDEX storm_landfall_idx      ON catalog.storm USING gin (landfall_countries);
CREATE INDEX storm_search_trgm_idx   ON catalog.storm USING gin (search_text gin_trgm_ops);
CREATE INDEX storm_track_gix         ON catalog.storm USING gist (track);

CREATE TABLE catalog.storm_landfall (
  sid      text        NOT NULL,
  seq      smallint    NOT NULL,
  country  text        NOT NULL CHECK (country IN ('PH','JP')),
  at       timestamptz NOT NULL,
  position geography(Point, 4326) NOT NULL,
  place_id text,
  PRIMARY KEY (sid, seq)
);
COMMENT ON TABLE catalog.storm_landfall IS 'Landfalls in covered countries, in time order (StormDetail.landfalls).';

CREATE TABLE catalog.storm_fix (
  sid              text        NOT NULL,
  observed_at      timestamptz NOT NULL,
  position         geography(Point, 4326) NOT NULL,
  wind_kt          smallint,
  wind_agency      text        CHECK (wind_agency IN ('jma','jtwc','pagasa','wmo','cma','hko','kma')),
  pressure_hpa     smallint,
  gust_kt          smallint,
  jtwc_wind_kt     smallint,
  jtwc_pressure_hpa smallint,
  jma_wind_kt      smallint,
  jma_pressure_hpa smallint,
  jma_grade        smallint    CHECK (jma_grade BETWEEN 2 AND 9),
  sshs_category    smallint    CHECK (sshs_category BETWEEN -5 AND 5),
  nature           text        CHECK (nature IN ('disturbance','tropical','extratropical','subtropical','not-reported','mixed')),
  dist_to_land_km  smallint,
  speed_kt         smallint,
  direction_deg    smallint    CHECK (direction_deg BETWEEN 0 AND 360),
  PRIMARY KEY (sid, observed_at)
);
COMMENT ON TABLE catalog.storm_fix IS
  'Best-track (observed) fixes only: IBTrACS rows with an original (O) flag. The 3-hourly interpolations and the hourly replay track live in the static stores.';
COMMENT ON COLUMN catalog.storm_fix.wind_kt IS 'Preferred sustained wind (JTWC, else JMA, else WMO); wind_agency says which.';
CREATE INDEX storm_fix_position_gix ON catalog.storm_fix USING gist (position);

CREATE TABLE catalog.pagasa_name (
  sid          text     PRIMARY KEY,
  pagasa_name  text     NOT NULL,
  intl_name    text     NOT NULL,
  season       smallint NOT NULL,
  source_url   text
);
COMMENT ON TABLE catalog.pagasa_name IS 'PAGASA local names matched to IBTrACS SIDs (pipeline/crosswalk/pagasa_names_sid.csv). Served as localNames.ph.';
CREATE INDEX pagasa_name_lower_idx ON catalog.pagasa_name (lower(pagasa_name));

CREATE TABLE catalog.place (
  place_id         text     PRIMARY KEY CHECK (place_id ~ '^(PH-[0-9]{10}|JP-[0-9]{5})$'),
  country          text     NOT NULL CHECK (country IN ('PH','JP')),
  kind             text     NOT NULL CHECK (kind IN ('city','municipality','special-ward','ward','town','village')),
  name             text     NOT NULL,
  name_ja          text,
  admin1           text     NOT NULL,
  admin1_ja        text,
  admin2           text,
  population       integer  CHECK (population >= 0),
  area_km2         numeric(9,2) NOT NULL CHECK (area_km2 > 0),
  centroid         geography(Point, 4326) NOT NULL,
  geom             geography(MultiPolygon, 4326) NOT NULL,
  geom_display     geography(MultiPolygon, 4326) NOT NULL,
  search_text      text     NOT NULL DEFAULT '',
  CHECK ((country = 'PH') = (place_id LIKE 'PH-%'))
);
COMMENT ON TABLE catalog.place IS 'PH ADM3 (cities/municipalities, PSGC) and JP municipalities (JIS X 0402).';
COMMENT ON COLUMN catalog.place.geom IS 'Boundary simplified to about 100 m. Used for containment and distance queries; never served.';
COMMENT ON COLUMN catalog.place.geom_display IS 'Display simplification (at most 1,500 vertices) served by GET /v1/places/{placeId}, inside the 64 KB cap. Full resolution stays in the static stores.';
COMMENT ON COLUMN catalog.place.search_text IS 'Lower-cased name, Japanese name and admin names joined by '' | ''.';
CREATE INDEX place_geom_gix        ON catalog.place USING gist (geom);
CREATE INDEX place_centroid_gix    ON catalog.place USING gist (centroid);
CREATE INDEX place_search_trgm_idx ON catalog.place USING gin (search_text gin_trgm_ops);
CREATE INDEX place_country_idx     ON catalog.place (country, population DESC NULLS LAST, place_id);

CREATE TABLE catalog.place_storm_exposure (
  place_id             text         NOT NULL,
  sid                  text         NOT NULL,
  season               smallint     NOT NULL,
  closest_approach_km  numeric(5,1) NOT NULL CHECK (closest_approach_km BETWEEN 0 AND 500),
  closest_approach_at  timestamptz  NOT NULL,
  max_wind_kt_r50      smallint,
  max_wind_kt_r100     smallint,
  max_wind_kt_r200     smallint,
  max_wind_kt_r300     smallint,
  max_wind_kt_r500     smallint,
  max_gust_kt_r50      smallint,
  max_gust_kt_r100     smallint,
  max_gust_kt_r200     smallint,
  max_gust_kt_r300     smallint,
  max_gust_kt_r500     smallint,
  hours_r50            smallint     NOT NULL DEFAULT 0,
  hours_r100           smallint     NOT NULL DEFAULT 0,
  hours_r200           smallint     NOT NULL DEFAULT 0,
  hours_r300           smallint     NOT NULL DEFAULT 0,
  hours_r500           smallint     NOT NULL DEFAULT 0,
  PRIMARY KEY (place_id, sid)
);
COMMENT ON TABLE catalog.place_storm_exposure IS
  'Precomputed storm x place pairs whose centre passed within 500 km of the place boundary. Drives "typhoons that hit my town". '
  'Per radius band (50/100/200/300/500 km, the RadiusKm enum): max wind/gust while the centre was inside the band and hours inside (hourly interpolated track). '
  'A pair is within radius R exactly when closest_approach_km <= R.';
COMMENT ON COLUMN catalog.place_storm_exposure.closest_approach_km IS 'Geodesic distance from the track to the boundary, rounded to 0.1 km. This exact value is the cursor keyset for sort=closest.';
COMMENT ON COLUMN catalog.place_storm_exposure.season IS 'Denormalised from catalog.storm for from/to filters.';
CREATE INDEX pse_place_closest_idx ON catalog.place_storm_exposure (place_id, closest_approach_km, sid);
CREATE INDEX pse_place_date_idx    ON catalog.place_storm_exposure (place_id, closest_approach_at DESC, sid);
CREATE INDEX pse_sid_closest_idx   ON catalog.place_storm_exposure (sid, closest_approach_km, place_id);

-- migrate:down

DROP TABLE catalog.place_storm_exposure;
DROP TABLE catalog.place;
DROP TABLE catalog.pagasa_name;
DROP TABLE catalog.storm_fix;
DROP TABLE catalog.storm_landfall;
DROP TABLE catalog.storm;
DROP VIEW catalog.current_dataset_version;
DROP TABLE catalog.dataset_version;
