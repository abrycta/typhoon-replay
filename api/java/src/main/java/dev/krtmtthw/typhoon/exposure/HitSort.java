package dev.krtmtthw.typhoon.exposure;

import java.util.Optional;

import dev.krtmtthw.typhoon.shared.web.Cursor;

/**
 * Sorts of the "storms that hit" queries (HitSort parameter): the keyset expression over the hit columns (alias h)
 * {@code km, at, wind, gust} and its cursor kind. Ties break by storm id ascending.
 */
public enum HitSort {
    CLOSEST("closest", "h.km", true, Cursor.Kind.NUMBER),
    PEAK_WIND_DESC("peak-wind-desc", "coalesce(h.wind, -1)", false, Cursor.Kind.NUMBER),
    PEAK_GUST_DESC("peak-gust-desc", "coalesce(h.gust, -1)", false, Cursor.Kind.NUMBER),
    DATE_DESC("date-desc", "h.at", false, Cursor.Kind.TIMESTAMP);

    private final String wire;
    private final String key;
    private final boolean ascending;
    private final Cursor.Kind kind;

    HitSort(String wire, String key, boolean ascending, Cursor.Kind kind) {
        this.wire = wire;
        this.key = key;
        this.ascending = ascending;
        this.kind = kind;
    }

    public String wire() {
        return wire;
    }

    public String key() {
        return key;
    }

    public boolean ascending() {
        return ascending;
    }

    public Cursor.Kind kind() {
        return kind;
    }

    public static Optional<HitSort> parse(String wire) {
        for (HitSort s : values()) {
            if (s.wire.equals(wire)) {
                return Optional.of(s);
            }
        }
        return Optional.empty();
    }
}
