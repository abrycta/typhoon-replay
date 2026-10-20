package dev.krtmtthw.typhoon.accounts;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

import dev.krtmtthw.typhoon.contract.model.PlaceSummary;
import dev.krtmtthw.typhoon.contract.model.SavedPlace;
import dev.krtmtthw.typhoon.exposure.PlaceDirectory;
import dev.krtmtthw.typhoon.shared.catalog.CatalogRows;
import dev.krtmtthw.typhoon.shared.problem.ApiException;
import dev.krtmtthw.typhoon.shared.problem.ProblemType;

/**
 * A user's saved places ({@code app.saved_place}): a catalogue place (stored at its centroid) or an arbitrary point.
 * The database enforces the rules every backend shares: 20 per user (trigger → 422) and no duplicates (unique
 * index → 409). Also the module API the alerts module uses to check ownership.
 */
@Service
public class SavedPlaces {

    private static final String SELECT = "SELECT sp.id, sp.label, sp.place_id, sp.lon, sp.lat, sp.created_at, sp.updated_at, "
            + CatalogRows.PLACE_COLUMNS + " FROM app.saved_place sp LEFT JOIN catalog.place p ON p.place_id = sp.place_id ";

    private final JdbcClient jdbc;
    private final PlaceDirectory places;

    SavedPlaces(JdbcClient jdbc, PlaceDirectory places) {
        this.jdbc = jdbc;
        this.places = places;
    }

    /** Oldest first. */
    public List<SavedPlace> list(UUID userId) {
        return jdbc.sql(SELECT + "WHERE sp.user_id = :user ORDER BY sp.created_at, sp.id").param("user", userId)
                .query((rs, n) -> row(rs)).list();
    }

    public SavedPlace create(UUID userId, String placeId, List<BigDecimal> position, String label) {
        if ((placeId == null) == (position == null)) {
            throw ApiException.unprocessable("Give exactly one of placeId or position.");
        }
        BigDecimal lon;
        BigDecimal lat;
        String finalLabel = label;
        if (placeId != null) {
            PlaceSummary place = places.summary(placeId)
                    .orElseThrow(() -> ApiException.unprocessable("Unknown placeId " + placeId + "."));
            lon = place.getCentroid().get(0);
            lat = place.getCentroid().get(1);
            if (finalLabel == null) {
                finalLabel = place.getName().length() > 80 ? place.getName().substring(0, 80) : place.getName();
            }
        } else {
            lon = position.get(0).setScale(4, RoundingMode.HALF_UP);
            lat = position.get(1).setScale(4, RoundingMode.HALF_UP);
            if (lon.compareTo(BigDecimal.valueOf(-180)) <= 0 || lon.compareTo(BigDecimal.valueOf(180)) > 0
                    || lat.abs().compareTo(BigDecimal.valueOf(90)) > 0) {
                throw ApiException.unprocessable("position must be [lon, lat] with lon in (-180, 180] and lat in [-90, 90].");
            }
            if (finalLabel == null) {
                finalLabel = CatalogRows.tidy(lat).toPlainString() + ", " + CatalogRows.tidy(lon).toPlainString();
            }
        }
        UUID id;
        try {
            id = jdbc.sql("""
                    INSERT INTO app.saved_place (user_id, label, place_id, lon, lat)
                    VALUES (:user, :label, :placeId, :lon, :lat) RETURNING id""")
                    .param("user", userId).param("label", finalLabel).param("placeId", placeId)
                    .param("lon", lon).param("lat", lat).query(UUID.class).single();
        } catch (DuplicateKeyException e) {
            throw new ApiException(ProblemType.CONFLICT, "This place is already saved.");
        } catch (DataIntegrityViolationException e) {
            if (String.valueOf(e.getMostSpecificCause().getMessage()).contains("saved place limit")) {
                throw ApiException.unprocessable("At most 20 saved places.");
            }
            throw e;
        }
        return find(userId, id).orElseThrow();
    }

    public Optional<SavedPlace> rename(UUID userId, UUID id, String label) {
        int updated = jdbc.sql("UPDATE app.saved_place SET label = :label, updated_at = now() WHERE id = :id AND user_id = :user")
                .param("label", label).param("id", id).param("user", userId).update();
        return updated == 0 ? Optional.empty() : find(userId, id);
    }

    /** Also removes it from the alert subscription (FK cascade). */
    public boolean delete(UUID userId, UUID id) {
        return jdbc.sql("DELETE FROM app.saved_place WHERE id = :id AND user_id = :user")
                .param("id", id).param("user", userId).update() > 0;
    }

    /** True when every id is one of the user's saved places. */
    public boolean allOwnedBy(UUID userId, Collection<UUID> ids) {
        if (ids.isEmpty()) {
            return true;
        }
        Integer owned = jdbc.sql("SELECT count(*) FROM app.saved_place WHERE user_id = :user AND id = ANY(:ids)")
                .param("user", userId).param("ids", ids.toArray(UUID[]::new)).query(Integer.class).single();
        return owned == ids.size();
    }

    private Optional<SavedPlace> find(UUID userId, UUID id) {
        return jdbc.sql(SELECT + "WHERE sp.id = :id AND sp.user_id = :user").param("id", id).param("user", userId)
                .query((rs, n) -> row(rs)).optional();
    }

    private static SavedPlace row(java.sql.ResultSet rs) throws java.sql.SQLException {
        SavedPlace sp = new SavedPlace(rs.getObject("id", UUID.class), rs.getString("label"),
                CatalogRows.lonLat(rs.getBigDecimal("lon"), rs.getBigDecimal("lat")),
                CatalogRows.timestamp(rs, "created_at"), CatalogRows.timestamp(rs, "updated_at"));
        sp.setPlaceId(rs.getString("place_id"));
        if (rs.getString("p_id") != null) {
            sp.setPlace(CatalogRows.placeSummary(rs));
        }
        return sp;
    }
}
