package dev.krtmtthw.typhoon.alerts.internal;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import dev.krtmtthw.typhoon.contract.model.AlertPreferences;
import dev.krtmtthw.typhoon.contract.model.RadiusKm;
import dev.krtmtthw.typhoon.shared.catalog.CatalogRows;

/**
 * {@code app.alert_subscription} and its places. Backends only store preferences; matching and sending run in the
 * shared pipeline job (CONTRACT-GUIDE §0, §11).
 */
@Repository
public class AlertSubscriptions {

    private final JdbcClient jdbc;

    public AlertSubscriptions(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /** The stored preferences, or the defaults ({@code enabled: false}, 200 km, 64 kt, all places, {@code en}). */
    public AlertPreferences read(UUID userId) {
        AlertPreferences prefs = jdbc.sql("""
                SELECT a.enabled, a.radius_km, a.min_wind_kt, a.language, a.updated_at
                FROM app.alert_subscription a WHERE a.user_id = :user""").param("user", userId).query((rs, n) -> {
            AlertPreferences p = new AlertPreferences(rs.getBoolean("enabled"), RadiusKm.fromValue(rs.getInt("radius_km")),
                    BigDecimal.valueOf(rs.getInt("min_wind_kt")), new LinkedHashSet<>(),
                    AlertPreferences.LanguageEnum.fromValue(rs.getString("language")));
            p.setUpdatedAt(CatalogRows.timestamp(rs, "updated_at"));
            return p;
        }).optional().orElseGet(() -> new AlertPreferences(false, RadiusKm.NUMBER_200, BigDecimal.valueOf(64),
                new LinkedHashSet<>(), AlertPreferences.LanguageEnum.EN));
        prefs.getSavedPlaceIds().addAll(jdbc.sql("""
                SELECT asp.saved_place_id FROM app.alert_subscription_place asp
                JOIN app.saved_place sp ON sp.id = asp.saved_place_id
                WHERE asp.user_id = :user ORDER BY sp.created_at, sp.id""").param("user", userId).query(UUID.class).list());
        jdbc.sql("SELECT email FROM auth.app_user WHERE id = :user").param("user", userId).query(String.class).optional()
                .ifPresent(prefs::setEmail);
        return prefs;
    }

    @Transactional
    public void replace(UUID userId, boolean enabled, int radiusKm, BigDecimal minWindKt, String language, Set<UUID> places) {
        jdbc.sql("""
                INSERT INTO app.alert_subscription (user_id, enabled, radius_km, min_wind_kt, language)
                VALUES (:user, :enabled, :radius, :minWind, :language)
                ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled, radius_km = EXCLUDED.radius_km,
                  min_wind_kt = EXCLUDED.min_wind_kt, language = EXCLUDED.language, updated_at = now()""")
                .param("user", userId).param("enabled", enabled).param("radius", radiusKm)
                .param("minWind", minWindKt.setScale(0, RoundingMode.HALF_UP).intValueExact())
                .param("language", language).update();
        jdbc.sql("DELETE FROM app.alert_subscription_place WHERE user_id = :user").param("user", userId).update();
        if (!places.isEmpty()) {
            jdbc.sql("""
                    INSERT INTO app.alert_subscription_place (user_id, saved_place_id)
                    SELECT :user, unnest(CAST(:ids AS uuid[]))""")
                    .param("user", userId).param("ids", places.toArray(UUID[]::new)).update();
        }
    }

    /** One-click unsubscribe; false when no subscription holds the token. */
    public boolean unsubscribe(String token) {
        return jdbc.sql("UPDATE app.alert_subscription SET enabled = false, updated_at = now() WHERE unsubscribe_token = :t")
                .param("t", token).update() > 0;
    }
}
