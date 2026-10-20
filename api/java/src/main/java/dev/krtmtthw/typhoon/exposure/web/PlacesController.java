package dev.krtmtthw.typhoon.exposure.web;

import java.math.BigDecimal;
import java.util.List;
import java.util.Set;

import jakarta.servlet.http.HttpServletRequest;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RestController;

import dev.krtmtthw.typhoon.contract.api.PlacesApi;
import dev.krtmtthw.typhoon.contract.model.CountryCode;
import dev.krtmtthw.typhoon.contract.model.NearestPlace;
import dev.krtmtthw.typhoon.contract.model.PlaceDetail;
import dev.krtmtthw.typhoon.contract.model.PlaceSearchResults;
import dev.krtmtthw.typhoon.contract.model.RadiusKm;
import dev.krtmtthw.typhoon.contract.model.StormHitPage;
import dev.krtmtthw.typhoon.exposure.HitSort;
import dev.krtmtthw.typhoon.exposure.internal.HitQueries;
import dev.krtmtthw.typhoon.exposure.internal.PlaceQueries;
import dev.krtmtthw.typhoon.shared.catalog.DatasetVersion;
import dev.krtmtthw.typhoon.shared.problem.ApiException;
import dev.krtmtthw.typhoon.shared.web.Cursor;
import dev.krtmtthw.typhoon.shared.web.Etags;
import dev.krtmtthw.typhoon.shared.web.Paging;

/** Places and "typhoons that hit my town" (tag {@code places}). */
@RestController
class PlacesController implements PlacesApi {

    private static final Set<String> SEARCH_PARAMS = Set.of("q", "country", "limit");
    private static final Set<String> POINT_PARAMS = Set.of("lat", "lon");
    private static final Set<String> NO_PARAMS = Set.of();
    private static final Set<String> HIT_PARAMS = Set.of("radiusKm", "minWindKt", "from", "to", "sort", "cursor", "limit");
    private static final Set<String> POINT_HIT_PARAMS = Set.of("lat", "lon", "radiusKm", "minWindKt", "from", "to", "sort",
            "cursor", "limit");

    private final PlaceQueries places;
    private final HitQueries hits;
    private final DatasetVersion dataset;
    private final Paging paging;
    private final HttpServletRequest request;

    PlacesController(PlaceQueries places, HitQueries hits, DatasetVersion dataset, Paging paging, HttpServletRequest request) {
        this.places = places;
        this.hits = hits;
        this.dataset = dataset;
        this.paging = paging;
        this.request = request;
    }

    @Override
    public ResponseEntity<PlaceSearchResults> searchPlaces(String q, CountryCode country, Integer limit, String ifNoneMatch) {
        String etag = dataset.etag(request, SEARCH_PARAMS);
        if (Etags.matches(ifNoneMatch, etag)) {
            return Etags.notModified(etag);
        }
        List<dev.krtmtthw.typhoon.contract.model.PlaceSummary> found =
                places.search(q, country == null ? null : country.getValue(), limit);
        return ResponseEntity.ok().eTag(etag).body(new PlaceSearchResults(found));
    }

    @Override
    public ResponseEntity<NearestPlace> getNearestPlace(BigDecimal lat, BigDecimal lon, String ifNoneMatch) {
        String etag = dataset.etag(request, POINT_PARAMS);
        if (Etags.matches(ifNoneMatch, etag)) {
            return Etags.notModified(etag);
        }
        NearestPlace nearest = places.nearest(lat, lon)
                .orElseThrow(() -> ApiException.notFound("No covered place within 50 km of this point."));
        return ResponseEntity.ok().eTag(etag).body(nearest);
    }

    @Override
    public ResponseEntity<PlaceDetail> getPlace(String placeId, String ifNoneMatch) {
        String etag = dataset.etag(request, NO_PARAMS);
        if (Etags.matches(ifNoneMatch, etag)) {
            return Etags.notModified(etag);
        }
        PlaceDetail detail = places.detail(placeId).orElseThrow(() -> ApiException.notFound("No such place."));
        return ResponseEntity.ok().eTag(etag).body(detail);
    }

    @Override
    public ResponseEntity<StormHitPage> listPlaceStorms(String placeId, RadiusKm radiusKm, Integer minWindKt, Integer from,
            Integer to, String sort, String cursor, Integer limit, String ifNoneMatch) {
        HitSort hitSort = parseSort(sort);
        Cursor c = Cursor.decode(cursor, hitSort.wire(), hitSort.kind());
        String etag = dataset.etag(request, HIT_PARAMS);
        if (Etags.matches(ifNoneMatch, etag)) {
            return Etags.notModified(etag);
        }
        if (!places.exists(placeId)) {
            throw ApiException.notFound("No such place.");
        }
        StormHitPage page = hits.placeStorms(placeId, radiusKm, new HitQueries.Filter(minWindKt, from, to), hitSort, c, limit);
        return paging.page(request, etag, page, StormHitPage::getNextCursor);
    }

    @Override
    public ResponseEntity<StormHitPage> listPointStorms(BigDecimal lat, BigDecimal lon, RadiusKm radiusKm, Integer minWindKt,
            Integer from, Integer to, String sort, String cursor, Integer limit, String ifNoneMatch) {
        HitSort hitSort = parseSort(sort);
        Cursor c = Cursor.decode(cursor, hitSort.wire(), hitSort.kind());
        String etag = dataset.etag(request, POINT_HIT_PARAMS);
        if (Etags.matches(ifNoneMatch, etag)) {
            return Etags.notModified(etag);
        }
        StormHitPage page = hits.pointStorms(lat, lon, radiusKm, new HitQueries.Filter(minWindKt, from, to), hitSort, c, limit);
        return paging.page(request, etag, page, StormHitPage::getNextCursor);
    }

    private static HitSort parseSort(String sort) {
        return HitSort.parse(sort).orElseThrow(() -> ApiException.validation("#/query/sort",
                "must be one of closest, peak-wind-desc, peak-gust-desc, date-desc"));
    }
}
