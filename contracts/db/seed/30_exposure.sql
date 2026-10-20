-- Precompute catalog.place_storm_exposure from the fixture fixes, the same way the pipeline does
-- (the pipeline runs this per season on the full catalogue): interpolate the best track to hourly points,
-- measure geodesic distance to each place boundary, aggregate per radius band.
WITH ordered AS (
  SELECT sid, observed_at, ST_X(position::geometry) AS lon, ST_Y(position::geometry) AS lat, wind_kt, gust_kt,
         lead(observed_at) OVER w AS t2, lead(ST_X(position::geometry)) OVER w AS lon2,
         lead(ST_Y(position::geometry)) OVER w AS lat2, lead(wind_kt) OVER w AS wind2, lead(gust_kt) OVER w AS gust2
  FROM catalog.storm_fix
  WINDOW w AS (PARTITION BY sid ORDER BY observed_at)
),
hourly AS (
  SELECT o.sid, o.observed_at + make_interval(hours => h) AS at,
         ST_SetSRID(ST_MakePoint(o.lon + (o.lon2 - o.lon) * f, o.lat + (o.lat2 - o.lat) * f), 4326)::geography AS pos,
         round(o.wind_kt + (o.wind2 - o.wind_kt) * f)::smallint AS wind_kt,
         round(o.gust_kt + (o.gust2 - o.gust_kt) * f)::smallint AS gust_kt
  FROM ordered o
  CROSS JOIN LATERAL generate_series(0, (extract(epoch FROM o.t2 - o.observed_at) / 3600)::int - 1) AS h
  CROSS JOIN LATERAL (SELECT h / (extract(epoch FROM o.t2 - o.observed_at) / 3600) AS f) ff
  WHERE o.t2 IS NOT NULL
  UNION ALL
  SELECT * FROM (
    SELECT DISTINCT ON (sid) sid, observed_at, position, wind_kt, gust_kt
    FROM catalog.storm_fix ORDER BY sid, observed_at DESC) last_fix
),
dist AS (
  SELECT p.place_id, h.sid, h.at, h.wind_kt, h.gust_kt, ST_Distance(p.geom, h.pos) / 1000.0 AS km
  FROM catalog.place p JOIN hourly h ON ST_DWithin(p.geom, h.pos, 500000)
)
INSERT INTO catalog.place_storm_exposure (
  place_id, sid, season, closest_approach_km, closest_approach_at,
  max_wind_kt_r50, max_wind_kt_r100, max_wind_kt_r200, max_wind_kt_r300, max_wind_kt_r500,
  max_gust_kt_r50, max_gust_kt_r100, max_gust_kt_r200, max_gust_kt_r300, max_gust_kt_r500,
  hours_r50, hours_r100, hours_r200, hours_r300, hours_r500)
SELECT d.place_id, d.sid, s.season,
       round((min(d.km))::numeric, 1),
       (array_agg(d.at ORDER BY d.km, d.at))[1],
       max(d.wind_kt) FILTER (WHERE d.km <= 50),  max(d.wind_kt) FILTER (WHERE d.km <= 100),
       max(d.wind_kt) FILTER (WHERE d.km <= 200), max(d.wind_kt) FILTER (WHERE d.km <= 300),
       max(d.wind_kt) FILTER (WHERE d.km <= 500),
       max(d.gust_kt) FILTER (WHERE d.km <= 50),  max(d.gust_kt) FILTER (WHERE d.km <= 100),
       max(d.gust_kt) FILTER (WHERE d.km <= 200), max(d.gust_kt) FILTER (WHERE d.km <= 300),
       max(d.gust_kt) FILTER (WHERE d.km <= 500),
       count(*) FILTER (WHERE d.km <= 50),  count(*) FILTER (WHERE d.km <= 100),
       count(*) FILTER (WHERE d.km <= 200), count(*) FILTER (WHERE d.km <= 300),
       count(*) FILTER (WHERE d.km <= 500)
FROM dist d JOIN catalog.storm s USING (sid)
GROUP BY d.place_id, d.sid, s.season;
