package dev.krtmtthw.typhoon.live.web;

import java.util.regex.Pattern;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import dev.krtmtthw.typhoon.contract.api.LiveApi;
import dev.krtmtthw.typhoon.contract.model.LiveSnapshot;
import dev.krtmtthw.typhoon.live.internal.LiveBroadcaster;
import dev.krtmtthw.typhoon.live.internal.LiveQueries;
import dev.krtmtthw.typhoon.shared.problem.ApiException;
import dev.krtmtthw.typhoon.shared.web.Etags;

/**
 * Active storms (tag {@code live}). The snapshot implements the generated interface; the stream
 * ({@code streamLiveEvents}) is hand-written because it returns an {@link SseEmitter}, which a generated
 * {@code ResponseEntity<String>} signature cannot express, so the codegen view marks that operation x-internal.
 */
@RestController
class LiveController implements LiveApi {

    private static final Pattern EVENT_ID = Pattern.compile("[0-9]{1,19}");

    private final LiveQueries live;
    private final LiveBroadcaster broadcaster;

    LiveController(LiveQueries live, LiveBroadcaster broadcaster) {
        this.live = live;
        this.broadcaster = broadcaster;
    }

    /** {@code Cache-Control: no-cache} (request filter), ETag {@code W/"s{seq}"}. */
    @Override
    public ResponseEntity<LiveSnapshot> getLiveSnapshot(String ifNoneMatch) {
        if (ifNoneMatch != null) {
            String current = "W/\"s" + live.revision() + "\"";
            if (Etags.matches(ifNoneMatch, current)) {
                return Etags.notModified(current);
            }
        }
        LiveSnapshot snapshot = live.snapshot();
        return ResponseEntity.ok().eTag("W/\"s" + snapshot.getSeq() + "\"").body(snapshot);
    }

    /** {@code GET /v1/live/stream}: CONTRACT-GUIDE §7. The header {@code Last-Event-ID} wins over {@code ?lastEventId=}. */
    @GetMapping("/v1/live/stream")
    ResponseEntity<SseEmitter> stream(@RequestHeader(value = "Last-Event-ID", required = false) String header,
            @RequestParam(value = "lastEventId", required = false) String query) {
        Long lastEventId = null;
        if (query != null) {
            lastEventId = parse(query, "#/query/lastEventId");
        }
        if (header != null) {
            lastEventId = parse(header, "#/header/Last-Event-ID");
        }
        return ResponseEntity.ok()
                .header("X-Accel-Buffering", "no")
                .header("Cache-Control", "no-cache")
                .body(broadcaster.open(lastEventId));
    }

    private static Long parse(String raw, String pointer) {
        if (!EVENT_ID.matcher(raw).matches()) {
            throw ApiException.validation(pointer, "must be 1-19 digits");
        }
        try {
            return Long.parseLong(raw);
        } catch (NumberFormatException e) {
            return Long.MAX_VALUE; // beyond any seq: outside the window, so the client gets a snapshot
        }
    }
}
