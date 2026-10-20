package dev.krtmtthw.typhoon.exposure.internal;

import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import dev.krtmtthw.typhoon.contract.model.PlaceHit;
import dev.krtmtthw.typhoon.contract.model.PlaceHitPage;
import dev.krtmtthw.typhoon.contract.model.RadiusKm;
import dev.krtmtthw.typhoon.contract.model.StormHit;
import dev.krtmtthw.typhoon.contract.model.StormHitPage;
import dev.krtmtthw.typhoon.exposure.HitSort;
import dev.krtmtthw.typhoon.shared.catalog.CatalogRows;
import dev.krtmtthw.typhoon.shared.web.Cursor;
import dev.krtmtthw.typhoon.shared.web.WebConfig;

/**
 * "Typhoons that hit my town". Places are served from the precomputed {@code catalog.place_storm_exposure} bands;
 * arbitrary points are computed on the fly from best tracks with geodesic distances on {@code geography}, using the
 * same hourly linear interpolation the pipeline uses for the bands, so a point inside a place gets comparable numbers.
 */
@Repository
public class HitQueries {

    /**
     * Candidate storms whose best-track LineString passes within the radius of the point (GiST on
     * {@code storm.track}), their fixes interpolated to hourly points, then aggregated like the pipeline does.
     */
    private static final String POINT_HITS = """
            pt AS (SELECT ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography AS g),
            cand AS (
              SELECT s.sid FROM catalog.storm s, pt
              WHERE s.track IS NOT NULL AND ST_DWithin(s.track, pt.g, :radiusM) %s
            ),
            ordered AS (
              SELECT f.sid, f.observed_at, ST_X(f.position::geometry) AS lon, ST_Y(f.position::geometry) AS lat,
                     f.wind_kt, f.gust_kt,
                     lead(f.observed_at) OVER w AS t2, lead(ST_X(f.position::geometry)) OVER w AS lon2,
                     lead(ST_Y(f.position::geometry)) OVER w AS lat2, lead(f.wind_kt) OVER w AS wind2,
                     lead(f.gust_kt) OVER w AS gust2
              FROM catalog.storm_fix f JOIN cand ON cand.sid = f.sid
              WINDOW w AS (PARTITION BY f.sid ORDER BY f.observed_at)
            ),
            hourly AS (
              SELECT o.sid, o.observed_at + make_interval(hours => hh) AS at,
                     ST_SetSRID(ST_MakePoint(o.lon + (o.lon2 - o.lon) * ff.f, o.lat + (o.lat2 - o.lat) * ff.f), 4326)::geography AS pos,
                     round(o.wind_kt + (o.wind2 - o.wind_kt) * ff.f)::smallint AS wind_kt,
                     round(o.gust_kt + (o.gust2 - o.gust_kt) * ff.f)::smallint AS gust_kt
              FROM ordered o
              CROSS JOIN LATERAL generate_series(0, (extract(epoch FROM o.t2 - o.observed_at) / 3600)::int - 1) AS hh
              CROSS JOIN LATERAL (SELECT hh / (extract(epoch FROM o.t2 - o.observed_at) / 3600) AS f) ff
              WHERE o.t2 IS NOT NULL
              UNION ALL
              SELECT * FROM (
                SELECT DISTINCT ON (f.sid) f.sid, f.observed_at, f.position, f.wind_kt, f.gust_kt
                FROM catalog.storm_fix f JOIN cand ON cand.sid = f.sid ORDER BY f.sid, f.observed_at DESC) last_fix
            ),
            dist AS (
              SELECT h.sid, h.at, h.wind_kt, h.gust_kt, ST_Distance(h.pos, pt.g) / 1000.0 AS km
              FROM hourly h, pt WHERE ST_DWithin(h.pos, pt.g, :radiusM)
            ),
            hits AS (
              SELECT sid, round(min(km)::numeric, 1) AS km, (array_agg(at ORDER BY km, at))[1] AS at,
                     max(wind_kt) AS wind, max(gust_kt) AS gust, count(*) AS hours
              FROM dist GROUP BY sid
            )""";

    private final JdbcClient jdbc;

    public HitQueries(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public record Filter(Integer minWindKt, Integer from, Integer to) {}

    /** Storms within {@code radius} of a catalogue place (precomputed bands). */
    public StormHitPage placeStorms(String placeId, RadiusKm radius, Filter f, HitSort sort, Cursor cursor, int limit) {
        int r = radius.getValue();
        Map<String, Object> p = new LinkedHashMap<>();
        StringBuilder hits = new StringBuilder("""
                hits AS (
                  SELECT e.sid, e.closest_approach_km AS km, e.closest_approach_at AS at,
                         e.max_wind_kt_r%1$d AS wind, e.max_gust_kt_r%1$d AS gust, e.hours_r%1$d AS hours
                  FROM catalog.place_storm_exposure e
                  WHERE e.place_id = :placeId AND e.closest_approach_km <= :radius""".formatted(r));
        p.put("placeId", placeId);
        p.put("radius", r);
        if (f.from() != null) {
            hits.append(" AND e.season >= :from");
            p.put("from", f.from());
        }
        if (f.to() != null) {
            hits.append(" AND e.season <= :to");
            p.put("to", f.to());
        }
        hits.append(")");
        return stormHits(hits.toString(), p, radius, f, sort, cursor, limit);
    }

    /** Storms within {@code radius} of an arbitrary point (computed from best tracks). */
    public StormHitPage pointStorms(BigDecimal lat, BigDecimal lon, RadiusKm radius, Filter f, HitSort sort, Cursor cursor,
            int limit) {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("lat", lat.doubleValue());
        p.put("lon", lon.doubleValue());
        p.put("radiusM", radius.getValue() * 1000.0);
        StringBuilder seasons = new StringBuilder();
        if (f.from() != null) {
            seasons.append(" AND s.season >= :from");
            p.put("from", f.from());
        }
        if (f.to() != null) {
            seasons.append(" AND s.season <= :to");
            p.put("to", f.to());
        }
        return stormHits(POINT_HITS.formatted(seasons), p, radius, f, sort, cursor, limit);
    }

    private StormHitPage stormHits(String hitsCte, Map<String, Object> p, RadiusKm radius, Filter f, HitSort sort,
            Cursor cursor, int limit) {
        StringBuilder sql = new StringBuilder("WITH ").append(hitsCte)
                .append(" SELECT ").append(CatalogRows.STORM_COLUMNS)
                .append(", h.km, h.at, h.wind, h.gust, h.hours, ").append(sort.key()).append(" AS sort_key")
                .append(" FROM hits h JOIN catalog.storm s ON s.sid = h.sid LEFT JOIN catalog.pagasa_name pn ON pn.sid = s.sid")
                .append(" WHERE true");
        if (f.minWindKt() != null) {
            sql.append(" AND h.wind >= :minWind");
            p.put("minWind", f.minWindKt());
        }
        appendKeyset(sql, p, sort.key(), sort.ascending(), "s.sid", cursor);
        sql.append(" ORDER BY ").append(sort.key()).append(sort.ascending() ? " ASC" : " DESC").append(", s.sid ASC LIMIT :limit");
        p.put("limit", limit + 1);

        List<Object[]> rows = jdbc.sql(sql.toString()).params(p).query((rs, n) -> {
            StormHit hit = new StormHit(CatalogRows.stormSummary(rs), CatalogRows.number(rs, "km"),
                    CatalogRows.timestamp(rs, "at"), CatalogRows.number(rs, "hours"));
            hit.setMaxWindKtWithinRadius(CatalogRows.number(rs, "wind"));
            hit.setMaxGustKtWithinRadius(CatalogRows.number(rs, "gust"));
            return new Object[] {hit, sortKey(rs.getObject("sort_key"))};
        }).list();

        StormHitPage page = new StormHitPage(new ArrayList<>(), radius);
        for (int i = 0; i < Math.min(limit, rows.size()); i++) {
            page.getItems().add((StormHit) rows.get(i)[0]);
        }
        if (rows.size() > limit) {
            Object[] last = rows.get(limit - 1);
            page.setNextCursor(Cursor.encode(sort.wire(), last[1], ((StormHit) last[0]).getStorm().getSid()));
        }
        return page;
    }

    /** Places within {@code radius} of a storm's track, closest first (keyset {@code [closestApproachKm]}). */
    public PlaceHitPage stormPlaces(String sid, RadiusKm radius, String country, Cursor cursor, int limit) {
        int r = radius.getValue();
        Map<String, Object> p = new LinkedHashMap<>();
        StringBuilder sql = new StringBuilder("SELECT ").append(CatalogRows.PLACE_COLUMNS).append("""
                , e.closest_approach_km AS km, e.closest_approach_at AS at, e.max_wind_kt_r%1$d AS wind,
                  e.max_gust_kt_r%1$d AS gust, e.hours_r%1$d AS hours
                FROM catalog.place_storm_exposure e JOIN catalog.place p ON p.place_id = e.place_id
                WHERE e.sid = :sid AND e.closest_approach_km <= :radius""".formatted(r));
        p.put("sid", sid);
        p.put("radius", r);
        if (country != null) {
            sql.append(" AND p.country = :country");
            p.put("country", country);
        }
        appendKeyset(sql, p, "e.closest_approach_km", true, "e.place_id", cursor);
        sql.append(" ORDER BY e.closest_approach_km ASC, e.place_id ASC LIMIT :limit");
        p.put("limit", limit + 1);

        List<PlaceHit> rows = jdbc.sql(sql.toString()).params(p).query((rs, n) -> {
            PlaceHit hit = new PlaceHit(CatalogRows.placeSummary(rs), CatalogRows.number(rs, "km"),
                    CatalogRows.timestamp(rs, "at"), CatalogRows.number(rs, "hours"));
            hit.setMaxWindKtWithinRadius(CatalogRows.number(rs, "wind"));
            hit.setMaxGustKtWithinRadius(CatalogRows.number(rs, "gust"));
            return hit;
        }).list();

        PlaceHitPage page = new PlaceHitPage(new ArrayList<>(rows.subList(0, Math.min(limit, rows.size()))), radius);
        if (rows.size() > limit) {
            PlaceHit last = rows.get(limit - 1);
            page.setNextCursor(Cursor.encode("closest", last.getClosestApproachKm(), last.getPlace().getId()));
        }
        return page;
    }

    private static void appendKeyset(StringBuilder sql, Map<String, Object> p, String key, boolean ascending, String idColumn,
            Cursor cursor) {
        if (cursor == null) {
            return;
        }
        String cmp = ascending ? ">" : "<";
        sql.append(" AND (").append(key).append(' ').append(cmp).append(" :k OR (").append(key).append(" = :k AND ")
                .append(idColumn).append(" > :lastId))");
        p.put("k", cursor.keyset().getFirst());
        p.put("lastId", cursor.lastId());
    }

    /** The cursor form of a sort key: numbers as BigDecimal, timestamps as RFC 3339 strings. */
    private static Object sortKey(Object raw) {
        if (raw instanceof java.sql.Timestamp ts) {
            return WebConfig.format(ts.toInstant().atOffset(java.time.ZoneOffset.UTC));
        }
        if (raw instanceof OffsetDateTime t) {
            return WebConfig.format(t);
        }
        if (raw instanceof Number n) {
            return new BigDecimal(n.toString());
        }
        return raw;
    }
}
