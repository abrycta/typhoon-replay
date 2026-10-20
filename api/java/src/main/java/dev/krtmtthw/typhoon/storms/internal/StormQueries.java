package dev.krtmtthw.typhoon.storms.internal;

import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import dev.krtmtthw.typhoon.contract.model.Agency;
import dev.krtmtthw.typhoon.contract.model.AgencyIntensity;
import dev.krtmtthw.typhoon.contract.model.CountryCode;
import dev.krtmtthw.typhoon.contract.model.DataSource;
import dev.krtmtthw.typhoon.contract.model.Landfall;
import dev.krtmtthw.typhoon.contract.model.PointGeometry;
import dev.krtmtthw.typhoon.contract.model.StormDetail;
import dev.krtmtthw.typhoon.contract.model.StormPeak;
import dev.krtmtthw.typhoon.contract.model.StormSummary;
import dev.krtmtthw.typhoon.contract.model.TrackFeature;
import dev.krtmtthw.typhoon.contract.model.TrackPointProperties;
import dev.krtmtthw.typhoon.shared.catalog.CatalogRows;
import dev.krtmtthw.typhoon.shared.web.Cursor;

/** Hand-written SQL over {@code catalog.storm*} (JdbcClient, named parameters, keyset paging). */
@Repository
public class StormQueries {

    private final JdbcClient jdbc;

    public StormQueries(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /** Sorts of {@code GET /v1/storms}: the ORDER BY expression, its direction and the cursor keyset kind. */
    public enum Sort {
        SEASON_DESC("season-desc", "s.season", false, Cursor.Kind.NUMBER),
        PEAK_WIND_DESC("peak-wind-desc", "coalesce(s.peak_wind_kt, -1)", false, Cursor.Kind.NUMBER),
        NAME("name", "upper(s.name) COLLATE \"C\"", true, Cursor.Kind.STRING);

        final String wire;
        final String key;
        final boolean ascending;
        final Cursor.Kind kind;

        Sort(String wire, String key, boolean ascending, Cursor.Kind kind) {
            this.wire = wire;
            this.key = key;
            this.ascending = ascending;
            this.kind = kind;
        }

        public String wire() {
            return wire;
        }

        public Cursor.Kind kind() {
            return kind;
        }

        public static Optional<Sort> parse(String wire) {
            for (Sort s : values()) {
                if (s.wire.equals(wire)) {
                    return Optional.of(s);
                }
            }
            return Optional.empty();
        }
    }

    public record Filter(String q, Integer season, Integer from, Integer to, String basin, String country, Integer minWindKt) {}

    public record Page(List<StormSummary> items, String nextCursor) {}

    public Page list(Filter f, Sort sort, Cursor cursor, int limit) {
        StringBuilder sql = new StringBuilder("SELECT ").append(CatalogRows.STORM_COLUMNS)
                .append(", ").append(sort.key).append(" AS sort_key FROM ").append(CatalogRows.STORM_FROM).append(" WHERE true");
        Map<String, Object> p = new LinkedHashMap<>();
        if (f.q() != null) {
            sql.append(" AND s.search_text LIKE '%' || lower(:q) || '%' ESCAPE '\\'");
            p.put("q", CatalogRows.likeEscape(f.q()));
        }
        if (f.season() != null) {
            sql.append(" AND s.season = :season");
            p.put("season", f.season());
        }
        if (f.from() != null) {
            sql.append(" AND s.season >= :from");
            p.put("from", f.from());
        }
        if (f.to() != null) {
            sql.append(" AND s.season <= :to");
            p.put("to", f.to());
        }
        if (f.basin() != null) {
            sql.append(" AND s.basin = :basin");
            p.put("basin", f.basin());
        }
        if (f.country() != null) {
            sql.append(" AND s.landfall_countries @> ARRAY[:country]::text[]");
            p.put("country", f.country());
        }
        if (f.minWindKt() != null) {
            sql.append(" AND s.peak_wind_kt >= :minWind");
            p.put("minWind", f.minWindKt());
        }
        if (cursor != null) {
            String cmp = sort.ascending ? ">" : "<";
            sql.append(" AND (").append(sort.key).append(' ').append(cmp).append(" :k OR (")
                    .append(sort.key).append(" = :k AND s.sid > :lastId))");
            p.put("k", cursor.keyset().getFirst());
            p.put("lastId", cursor.lastId());
        }
        sql.append(" ORDER BY ").append(sort.key).append(sort.ascending ? " ASC" : " DESC").append(", s.sid ASC LIMIT :limit");
        p.put("limit", limit + 1);

        List<Object[]> rows = jdbc.sql(sql.toString()).params(p)
                .query((rs, n) -> new Object[] {CatalogRows.stormSummary(rs), rs.getObject("sort_key")})
                .list();
        List<StormSummary> items = new ArrayList<>();
        String next = null;
        for (int i = 0; i < Math.min(limit, rows.size()); i++) {
            items.add((StormSummary) rows.get(i)[0]);
        }
        if (rows.size() > limit) {
            Object[] last = rows.get(limit - 1);
            Object key = last[1] instanceof Number n ? new BigDecimal(n.toString()) : last[1];
            next = Cursor.encode(sort.wire, key, ((StormSummary) last[0]).getSid());
        }
        return new Page(items, next);
    }

    public boolean exists(String sid) {
        return jdbc.sql("SELECT EXISTS (SELECT 1 FROM catalog.storm WHERE sid = :sid)").param("sid", sid)
                .query(Boolean.class).single();
    }

    public Optional<StormDetail> detail(String sid) {
        Optional<StormDetail> found = jdbc.sql("""
                SELECT s.*, pn.pagasa_name, pn.source_url AS pagasa_url,
                       round(ST_X(s.peak_position::geometry)::numeric, 4) AS peak_lon,
                       round(ST_Y(s.peak_position::geometry)::numeric, 4) AS peak_lat,
                       extract(epoch FROM s.ended_at - s.started_at) / 3600.0 AS duration_hours,
                       (SELECT ibtracs_version FROM catalog.dataset_version ORDER BY version DESC LIMIT 1) AS ibtracs_version
                FROM catalog.storm s LEFT JOIN catalog.pagasa_name pn ON pn.sid = s.sid
                WHERE s.sid = :sid""").param("sid", sid).query(StormQueries::detailRow).optional();
        found.ifPresent(d -> d.setLandfalls(landfalls(sid)));
        return found;
    }

    private static StormDetail detailRow(ResultSet rs, int n) throws SQLException {
        StormDetail d = new StormDetail()
                .sid(rs.getString("sid"))
                .name(rs.getString("name"))
                .season(rs.getInt("season"))
                .basin(dev.krtmtthw.typhoon.contract.model.Basin.fromValue(rs.getString("basin")))
                .startedAt(CatalogRows.timestamp(rs, "started_at"))
                .endedAt(CatalogRows.timestamp(rs, "ended_at"))
                .durationHours(CatalogRows.number(rs, "duration_hours"))
                .fixCount(rs.getInt("fix_count"))
                .landfallCountries(CatalogRows.countries(rs.getArray("landfall_countries")))
                .replayAvailable(rs.getBoolean("replay_available"));
        d.setLocalNames(CatalogRows.localNames(rs.getString("pagasa_name"), rs.getString("name_ja")));
        d.setNumber(CatalogRows.integer(rs, "number"));
        d.setAtcfId(rs.getString("atcf_id"));

        StormPeak peak = new StormPeak();
        peak.setWindKt(CatalogRows.number(rs, "peak_wind_kt"));
        String agency = rs.getString("peak_wind_agency");
        peak.setAgency(agency == null ? null : Agency.fromValue(agency));
        peak.setPressureHpa(CatalogRows.number(rs, "min_pressure_hpa"));
        peak.setAt(CatalogRows.timestamp(rs, "peak_at"));
        BigDecimal lon = rs.getBigDecimal("peak_lon");
        if (lon != null) {
            peak.setPosition(CatalogRows.lonLat(lon, rs.getBigDecimal("peak_lat")));
        }
        d.setPeak(peak);

        // Lifetime extremes per agency. In the WP basin "wmo" is JMA, so it is listed only when JMA itself is absent.
        List<AgencyIntensity> intensity = new ArrayList<>();
        addIntensity(intensity, Agency.JTWC, 1, rs, "jtwc");
        addIntensity(intensity, Agency.JMA, 10, rs, "jma");
        if (intensity.stream().noneMatch(i -> i.getAgency() == Agency.JMA)) {
            addIntensity(intensity, Agency.WMO, 10, rs, "wmo");
        }
        d.setIntensity(intensity);

        List<DataSource> sources = new ArrayList<>();
        String ibtracs = rs.getString("ibtracs_version");
        String version = ibtracs == null ? "v04r01" : ibtracs;
        DataSource best = new DataSource("ibtracs-" + version.toLowerCase(java.util.Locale.ROOT).replaceAll("[^a-z0-9]+", "-"),
                "IBTrACS " + version + " (NOAA NCEI)",
                java.net.URI.create("https://www.ncei.noaa.gov/products/international-best-track-archive"));
        best.setLicense("Public domain (NOAA)");
        sources.add(best);
        String pagasaUrl = rs.getString("pagasa_url");
        if (rs.getString("pagasa_name") != null && pagasaUrl != null) {
            sources.add(new DataSource("pagasa-names", "PAGASA local name crosswalk", java.net.URI.create(pagasaUrl)));
        }
        d.setSources(sources);
        return d;
    }

    private static void addIntensity(List<AgencyIntensity> out, Agency agency, int minutes, ResultSet rs, String prefix)
            throws SQLException {
        BigDecimal wind = CatalogRows.number(rs, prefix + "_max_wind_kt");
        BigDecimal pressure = CatalogRows.number(rs, prefix + "_min_pressure_hpa");
        if (wind == null && pressure == null) {
            return;
        }
        AgencyIntensity i = new AgencyIntensity(agency, minutes == 1
                ? AgencyIntensity.WindAveragingMinutesEnum.NUMBER_1 : AgencyIntensity.WindAveragingMinutesEnum.NUMBER_10);
        i.setMaxWindKt(wind);
        i.setMinPressureHpa(pressure);
        out.add(i);
    }

    private List<Landfall> landfalls(String sid) {
        return jdbc.sql("""
                SELECT country, at, place_id,
                       round(ST_X(position::geometry)::numeric, 4) AS lon, round(ST_Y(position::geometry)::numeric, 4) AS lat
                FROM catalog.storm_landfall WHERE sid = :sid ORDER BY seq""").param("sid", sid)
                .query((rs, n) -> {
                    Landfall l = new Landfall(CountryCode.fromValue(rs.getString("country")), CatalogRows.timestamp(rs, "at"),
                            CatalogRows.lonLat(rs.getBigDecimal("lon"), rs.getBigDecimal("lat")));
                    l.setPlaceId(rs.getString("place_id"));
                    return l;
                }).list();
    }

    /** Best-track fixes in time order. */
    public List<TrackFeature> track(String sid) {
        return jdbc.sql("""
                SELECT observed_at, wind_kt, wind_agency, gust_kt, pressure_hpa, nature, sshs_category, jma_grade,
                       dist_to_land_km, speed_kt, direction_deg,
                       round(ST_X(position::geometry)::numeric, 4) AS lon, round(ST_Y(position::geometry)::numeric, 4) AS lat
                FROM catalog.storm_fix WHERE sid = :sid ORDER BY observed_at""").param("sid", sid)
                .query((rs, n) -> {
                    TrackPointProperties p = new TrackPointProperties(CatalogRows.timestamp(rs, "observed_at"));
                    p.setWindKt(CatalogRows.number(rs, "wind_kt"));
                    String agency = rs.getString("wind_agency");
                    p.setWindAgency(agency == null ? null : Agency.fromValue(agency));
                    p.setGustKt(CatalogRows.number(rs, "gust_kt"));
                    p.setPressureHpa(CatalogRows.number(rs, "pressure_hpa"));
                    String nature = rs.getString("nature");
                    p.setNature(nature == null ? null : TrackPointProperties.NatureEnum.fromValue(nature));
                    p.setSshsCategory(CatalogRows.integer(rs, "sshs_category"));
                    p.setJmaGrade(CatalogRows.integer(rs, "jma_grade"));
                    p.setDistanceToLandKm(CatalogRows.number(rs, "dist_to_land_km"));
                    p.setSpeedKt(CatalogRows.number(rs, "speed_kt"));
                    p.setDirectionDeg(CatalogRows.number(rs, "direction_deg"));
                    PointGeometry g = new PointGeometry(PointGeometry.TypeEnum.POINT,
                            CatalogRows.lonLat(rs.getBigDecimal("lon"), rs.getBigDecimal("lat")));
                    return new TrackFeature(TrackFeature.TypeEnum.FEATURE, g, p);
                }).list();
    }
}
