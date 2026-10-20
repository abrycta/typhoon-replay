package dev.krtmtthw.typhoon.exposure;

import org.springframework.stereotype.Service;

import dev.krtmtthw.typhoon.contract.model.PlaceHitPage;
import dev.krtmtthw.typhoon.contract.model.RadiusKm;
import dev.krtmtthw.typhoon.exposure.internal.HitQueries;
import dev.krtmtthw.typhoon.exposure.internal.PlaceQueries;
import dev.krtmtthw.typhoon.shared.web.Cursor;

/**
 * The exposure module's API for other modules: the places a storm passed near (storms, for
 * {@code GET /v1/storms/{sid}/places}).
 */
@Service
public class PlaceDirectory {

    private final PlaceQueries places;
    private final HitQueries hits;

    PlaceDirectory(PlaceQueries places, HitQueries hits) {
        this.places = places;
        this.hits = hits;
    }

    /** Places within {@code radius} of a storm's track, closest first; cursor keyset {@code [closestApproachKm]}. */
    public PlaceHitPage placesNearStorm(String sid, RadiusKm radius, String country, String rawCursor, int limit) {
        Cursor cursor = Cursor.decode(rawCursor, "closest", Cursor.Kind.NUMBER);
        return hits.stormPlaces(sid, radius, country, cursor, limit);
    }
}
