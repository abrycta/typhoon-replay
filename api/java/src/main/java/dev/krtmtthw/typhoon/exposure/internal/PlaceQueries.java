package dev.krtmtthw.typhoon.exposure.internal;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import dev.krtmtthw.typhoon.contract.model.CountryCode;
import dev.krtmtthw.typhoon.contract.model.MultiPolygonGeometry;
import dev.krtmtthw.typhoon.contract.model.NearestPlace;
import dev.krtmtthw.typhoon.contract.model.PlaceDetail;
import dev.krtmtthw.typhoon.contract.model.PlaceKind;
import dev.krtmtthw.typhoon.contract.model.PlaceSummary;
import dev.krtmtthw.typhoon.shared.catalog.CatalogRows;
import tools.jackson.databind.json.JsonMapper;

/** Place search, nearest place and detail over {@code catalog.place} (PostGIS geography). */
@Repository
public class PlaceQueries {

    private final JdbcClient jdbc;
    private final JsonMapper json;

    public PlaceQueries(JdbcClient jdbc, JsonMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    /** Exact name match, then prefix, then substring (names and admin names); ties by population desc, then id. */
    public List<PlaceSummary> search(String q, String country, int limit) {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("q", q);
        p.put("like", CatalogRows.likeEscape(q));
        p.put("limit", limit);
        String countryFilter = "";
        if (country != null) {
            countryFilter = " AND p.country = :country";
            p.put("country", country);
        }
        return jdbc.sql("SELECT " + CatalogRows.PLACE_COLUMNS + " " + """
                FROM catalog.place p
                WHERE p.search_text LIKE '%' || lower(:like) || '%' ESCAPE '\\'""" + countryFilter + " " + """
                 ORDER BY CASE WHEN lower(p.name) = lower(:q) OR p.name_ja = :q THEN 0
                               WHEN lower(p.name) LIKE lower(:like) || '%' ESCAPE '\\' OR p.name_ja LIKE :like || '%' ESCAPE '\\' THEN 1
                               ELSE 2 END,
                          p.population DESC NULLS LAST, p.place_id
                 LIMIT :limit""").params(p).query((rs, n) -> CatalogRows.placeSummary(rs)).list();
    }

    /** The place containing the point, else the nearest boundary within 50 km. */
    public Optional<NearestPlace> nearest(BigDecimal lat, BigDecimal lon) {
        return jdbc.sql("WITH pt AS (SELECT ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography AS g) SELECT "
                + CatalogRows.PLACE_COLUMNS + " " + """
                , ST_Covers(p.geom, pt.g) AS contains, ST_Distance(p.geom, pt.g) / 1000.0 AS km
                FROM catalog.place p, pt
                WHERE ST_DWithin(p.geom, pt.g, 50000)
                ORDER BY ST_Distance(p.geom, pt.g), p.place_id
                LIMIT 1""").param("lat", lat.doubleValue()).param("lon", lon.doubleValue())
                .query((rs, n) -> {
                    boolean contains = rs.getBoolean("contains");
                    BigDecimal km = contains ? BigDecimal.ZERO
                            : CatalogRows.tidy(rs.getBigDecimal("km").setScale(1, RoundingMode.HALF_UP));
                    return new NearestPlace(CatalogRows.placeSummary(rs), contains, km);
                }).optional();
    }

    public boolean exists(String placeId) {
        return jdbc.sql("SELECT EXISTS (SELECT 1 FROM catalog.place WHERE place_id = :id)").param("id", placeId)
                .query(Boolean.class).single();
    }

    /** Detail with the display-simplified boundary (at most 1,500 vertices, inside the 64 KB cap). */
    public Optional<PlaceDetail> detail(String placeId) {
        return jdbc.sql("SELECT " + CatalogRows.PLACE_COLUMNS + " " + """
                , p.population, p.area_km2,
                  round(ST_XMin(p.geom_display::geometry)::numeric, 4) AS min_lon, round(ST_YMin(p.geom_display::geometry)::numeric, 4) AS min_lat,
                  round(ST_XMax(p.geom_display::geometry)::numeric, 4) AS max_lon, round(ST_YMax(p.geom_display::geometry)::numeric, 4) AS max_lat,
                  ST_AsGeoJSON(p.geom_display::geometry, 4) AS geojson
                FROM catalog.place p WHERE p.place_id = :id""").param("id", placeId).query((rs, n) -> {
            PlaceSummary s = CatalogRows.placeSummary(rs);
            PlaceDetail d = new PlaceDetail(s.getId(), CountryCode.fromValue(s.getCountry().getValue()),
                    PlaceKind.fromValue(s.getKind().getValue()), s.getName(), s.getAdmin1(), s.getCentroid(),
                    CatalogRows.tidy(rs.getBigDecimal("area_km2")),
                    List.of(CatalogRows.tidy(rs.getBigDecimal("min_lon")), CatalogRows.tidy(rs.getBigDecimal("min_lat")),
                            CatalogRows.tidy(rs.getBigDecimal("max_lon")), CatalogRows.tidy(rs.getBigDecimal("max_lat"))),
                    json.readValue(rs.getString("geojson"), MultiPolygonGeometry.class));
            d.setNameJa(s.getNameJa());
            d.setAdmin1Ja(s.getAdmin1Ja());
            d.setAdmin2(s.getAdmin2());
            d.setPopulation(CatalogRows.integer(rs, "population"));
            return d;
        }).optional();
    }
}
