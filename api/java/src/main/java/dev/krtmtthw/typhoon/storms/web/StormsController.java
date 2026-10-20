package dev.krtmtthw.typhoon.storms.web;

import java.util.Set;

import jakarta.servlet.http.HttpServletRequest;

import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RestController;

import dev.krtmtthw.typhoon.contract.api.StormsApi;
import dev.krtmtthw.typhoon.contract.model.Basin;
import dev.krtmtthw.typhoon.contract.model.CountryCode;
import dev.krtmtthw.typhoon.contract.model.PlaceHitPage;
import dev.krtmtthw.typhoon.contract.model.RadiusKm;
import dev.krtmtthw.typhoon.contract.model.StormDetail;
import dev.krtmtthw.typhoon.contract.model.StormPage;
import dev.krtmtthw.typhoon.contract.model.StormTrack;
import dev.krtmtthw.typhoon.exposure.PlaceDirectory;
import dev.krtmtthw.typhoon.shared.catalog.DatasetVersion;
import dev.krtmtthw.typhoon.shared.problem.ApiException;
import dev.krtmtthw.typhoon.shared.problem.ProblemType;
import dev.krtmtthw.typhoon.shared.web.Cursor;
import dev.krtmtthw.typhoon.shared.web.Etags;
import dev.krtmtthw.typhoon.shared.web.Paging;
import dev.krtmtthw.typhoon.storms.internal.StormQueries;

/** The storm catalogue (tag {@code storms}). */
@RestController
class StormsController implements StormsApi {

    private static final Set<String> LIST_PARAMS = Set.of("q", "season", "from", "to", "basin", "country", "minWindKt",
            "sort", "cursor", "limit");
    private static final Set<String> PLACES_PARAMS = Set.of("radiusKm", "country", "cursor", "limit");
    private static final MediaType GEO_JSON = MediaType.parseMediaType("application/geo+json");

    private final StormQueries storms;
    private final PlaceDirectory places;
    private final DatasetVersion dataset;
    private final Paging paging;
    private final HttpServletRequest request;

    StormsController(StormQueries storms, PlaceDirectory places, DatasetVersion dataset, Paging paging,
            HttpServletRequest request) {
        this.storms = storms;
        this.places = places;
        this.dataset = dataset;
        this.paging = paging;
        this.request = request;
    }

    @Override
    public ResponseEntity<StormPage> listStorms(String q, Integer season, Integer from, Integer to, Basin basin,
            CountryCode country, Integer minWindKt, String sort, String cursor, Integer limit, String ifNoneMatch) {
        if (season != null && (from != null || to != null)) {
            throw new ApiException(ProblemType.VALIDATION, "season cannot be combined with from/to.",
                    java.util.List.of(new ApiException.FieldProblem("#/query/season", "cannot be combined with from/to")));
        }
        StormQueries.Sort s = StormQueries.Sort.parse(sort).orElseThrow(() ->
                ApiException.validation("#/query/sort", "must be one of season-desc, peak-wind-desc, name"));
        Cursor c = Cursor.decode(cursor, s.wire(), s.kind());
        String etag = dataset.etag(request, LIST_PARAMS);
        if (Etags.matches(ifNoneMatch, etag)) {
            return Etags.notModified(etag);
        }
        StormQueries.Page page = storms.list(new StormQueries.Filter(q, season, from, to,
                basin == null ? null : basin.getValue(), country == null ? null : country.getValue(), minWindKt), s, c, limit);
        StormPage body = new StormPage(page.items());
        body.setNextCursor(page.nextCursor());
        return paging.page(request, etag, body, StormPage::getNextCursor);
    }

    @Override
    public ResponseEntity<StormDetail> getStorm(String sid, String ifNoneMatch) {
        String etag = dataset.etag(request, Set.of());
        if (Etags.matches(ifNoneMatch, etag)) {
            return Etags.notModified(etag);
        }
        StormDetail detail = storms.detail(sid).orElseThrow(() -> ApiException.notFound("No such storm."));
        return ResponseEntity.ok().eTag(etag).body(detail);
    }

    @Override
    public ResponseEntity<StormTrack> getStormTrack(String sid, String ifNoneMatch) {
        String etag = dataset.etag(request, Set.of());
        if (Etags.matches(ifNoneMatch, etag)) {
            return Etags.notModified(etag);
        }
        if (!storms.exists(sid)) {
            throw ApiException.notFound("No such storm.");
        }
        StormTrack track = new StormTrack(StormTrack.TypeEnum.FEATURE_COLLECTION, sid, StormTrack.ResolutionEnum.BEST_TRACK,
                storms.track(sid));
        return ResponseEntity.ok().eTag(etag).contentType(GEO_JSON).body(track);
    }

    @Override
    public ResponseEntity<PlaceHitPage> listStormPlaces(String sid, RadiusKm radiusKm, CountryCode country, String cursor,
            Integer limit, String ifNoneMatch) {
        Cursor.decode(cursor, "closest", Cursor.Kind.NUMBER);
        String etag = dataset.etag(request, PLACES_PARAMS);
        if (Etags.matches(ifNoneMatch, etag)) {
            return Etags.notModified(etag);
        }
        if (!storms.exists(sid)) {
            throw ApiException.notFound("No such storm.");
        }
        PlaceHitPage page = places.placesNearStorm(sid, radiusKm, country == null ? null : country.getValue(), cursor, limit);
        return paging.page(request, etag, page, PlaceHitPage::getNextCursor);
    }
}
