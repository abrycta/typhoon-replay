package dev.krtmtthw.typhoon.shared.catalog;

import java.math.BigDecimal;
import java.sql.Array;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;

import dev.krtmtthw.typhoon.contract.model.Agency;
import dev.krtmtthw.typhoon.contract.model.Basin;
import dev.krtmtthw.typhoon.contract.model.CountryCode;
import dev.krtmtthw.typhoon.contract.model.LocalNames;
import dev.krtmtthw.typhoon.contract.model.PlaceKind;
import dev.krtmtthw.typhoon.contract.model.PlaceSummary;
import dev.krtmtthw.typhoon.contract.model.StormSummary;

/**
 * Hand-written SQL fragments and row mappers for the two read models every catalogue query returns
 * ({@code StormSummary}, {@code PlaceSummary}). Kept in the shared module because storms, exposure and live all
 * embed them, and Modulith forbids the cycle a storms ↔ exposure dependency would create.
 */
public final class CatalogRows {

    /** From-clause for storm summaries: {@code s} = storm, {@code pn} = its PAGASA name. */
    public static final String STORM_FROM = "catalog.storm s LEFT JOIN catalog.pagasa_name pn ON pn.sid = s.sid";

    public static final String STORM_COLUMNS = """
            s.sid AS s_sid, s.name AS s_name, s.season AS s_season, s.basin AS s_basin, s.started_at AS s_started_at,
            s.ended_at AS s_ended_at, s.peak_wind_kt AS s_peak_wind_kt, s.peak_wind_agency AS s_peak_wind_agency,
            s.min_pressure_hpa AS s_min_pressure_hpa, s.landfall_countries AS s_landfall_countries,
            s.name_ja AS s_name_ja, pn.pagasa_name AS s_name_ph""";

    /** Place summary columns of {@code catalog.place p}; centroids rounded to 4 decimals (CONTRACT-GUIDE §3). */
    public static final String PLACE_COLUMNS = """
            p.place_id AS p_id, p.country AS p_country, p.kind AS p_kind, p.name AS p_name, p.name_ja AS p_name_ja,
            p.admin1 AS p_admin1, p.admin1_ja AS p_admin1_ja, p.admin2 AS p_admin2,
            round(ST_X(p.centroid::geometry)::numeric, 4) AS p_lon, round(ST_Y(p.centroid::geometry)::numeric, 4) AS p_lat""";

    private CatalogRows() {}

    public static StormSummary stormSummary(ResultSet rs) throws SQLException {
        StormSummary s = new StormSummary()
                .sid(rs.getString("s_sid"))
                .name(rs.getString("s_name"))
                .season(rs.getInt("s_season"))
                .basin(Basin.fromValue(rs.getString("s_basin")))
                .startedAt(timestamp(rs, "s_started_at"))
                .endedAt(timestamp(rs, "s_ended_at"))
                .landfallCountries(countries(rs.getArray("s_landfall_countries")));
        s.setLocalNames(localNames(rs.getString("s_name_ph"), rs.getString("s_name_ja")));
        s.setPeakWindKt(number(rs, "s_peak_wind_kt"));
        String agency = rs.getString("s_peak_wind_agency");
        s.setPeakWindAgency(agency == null ? null : Agency.fromValue(agency));
        s.setMinPressureHpa(number(rs, "s_min_pressure_hpa"));
        return s;
    }

    public static PlaceSummary placeSummary(ResultSet rs) throws SQLException {
        PlaceSummary p = new PlaceSummary()
                .id(rs.getString("p_id"))
                .country(CountryCode.fromValue(rs.getString("p_country")))
                .kind(PlaceKind.fromValue(rs.getString("p_kind")))
                .name(rs.getString("p_name"))
                .admin1(rs.getString("p_admin1"))
                .centroid(lonLat(rs.getBigDecimal("p_lon"), rs.getBigDecimal("p_lat")));
        p.setNameJa(rs.getString("p_name_ja"));
        p.setAdmin1Ja(rs.getString("p_admin1_ja"));
        p.setAdmin2(rs.getString("p_admin2"));
        return p;
    }

    public static LocalNames localNames(String ph, String ja) {
        if (ph == null && ja == null) {
            return null;
        }
        LocalNames names = new LocalNames();
        names.setPh(ph);
        names.setJa(ja);
        return names;
    }

    public static List<CountryCode> countries(Array array) throws SQLException {
        List<CountryCode> out = new ArrayList<>();
        if (array != null) {
            for (Object c : (Object[]) array.getArray()) {
                out.add(CountryCode.fromValue(c.toString()));
            }
        }
        return out;
    }

    /** {@code [lon, lat]}, longitude normalised to (-180, 180], trailing zeros dropped. */
    public static List<BigDecimal> lonLat(BigDecimal lon, BigDecimal lat) {
        BigDecimal x = lon;
        if (x.compareTo(BigDecimal.valueOf(-180)) <= 0) {
            x = x.add(BigDecimal.valueOf(360));
        } else if (x.compareTo(BigDecimal.valueOf(180)) > 0) {
            x = x.subtract(BigDecimal.valueOf(360));
        }
        return List.of(tidy(x), tidy(lat));
    }

    /** A nullable numeric column (smallint or numeric) as a BigDecimal. */
    public static BigDecimal number(ResultSet rs, String column) throws SQLException {
        BigDecimal v = rs.getBigDecimal(column);
        return v == null ? null : tidy(v);
    }

    public static Integer integer(ResultSet rs, String column) throws SQLException {
        int v = rs.getInt(column);
        return rs.wasNull() ? null : v;
    }

    public static OffsetDateTime timestamp(ResultSet rs, String column) throws SQLException {
        OffsetDateTime t = rs.getObject(column, OffsetDateTime.class);
        return t == null ? null : t.withOffsetSameInstant(ZoneOffset.UTC);
    }

    /** Drops trailing zeros without switching to exponent notation ({@code 11.0000} → {@code 11}). */
    public static BigDecimal tidy(BigDecimal v) {
        BigDecimal s = v.stripTrailingZeros();
        return s.scale() < 0 ? s.setScale(0) : s;
    }

    /** LIKE pattern escaping for user input ({@code \\} is the escape character). */
    public static String likeEscape(String s) {
        return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
    }
}
