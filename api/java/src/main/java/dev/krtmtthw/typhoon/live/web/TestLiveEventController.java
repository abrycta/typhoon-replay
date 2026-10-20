package dev.krtmtthw.typhoon.live.web;

import java.util.Map;
import java.util.Set;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import dev.krtmtthw.typhoon.live.internal.LiveQueries;
import dev.krtmtthw.typhoon.shared.TrProperties;
import dev.krtmtthw.typhoon.shared.problem.ApiException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Test hook {@code POST /v1/_test/live-events} (CONTRACT-GUIDE §10): {@code SELECT live.apply_event(type, payload)},
 * the ingestion job's own write path. Only with {@code TR_TEST_HOOKS=1}, otherwise 404 {@code not-found}.
 */
@RestController
class TestLiveEventController {

    private static final Set<String> TYPES = Set.of("storm-upserted", "storm-removed");

    private final boolean enabled;
    private final LiveQueries live;
    private final JsonMapper json;

    TestLiveEventController(TrProperties props, LiveQueries live, JsonMapper json) {
        this.enabled = props.testHooks();
        this.live = live;
        this.json = json;
    }

    record TestLiveEvent(String type, JsonNode payload) {}

    @PostMapping("/v1/_test/live-events")
    ResponseEntity<Map<String, Object>> apply(@RequestBody(required = false) TestLiveEvent body) {
        if (!enabled) {
            throw ApiException.notFound("No such resource.");
        }
        if (body == null || body.type() == null || !TYPES.contains(body.type())) {
            throw ApiException.validation("#/body/type", "must be storm-upserted or storm-removed");
        }
        if (body.payload() == null || !body.payload().isObject() || !body.payload().path("liveId").isString()) {
            throw ApiException.validation("#/body/payload", "must be an object with liveId");
        }
        long seq = live.apply(body.type(), json.writeValueAsString(body.payload()));
        return ResponseEntity.status(HttpStatus.CREATED).body(Map.of("seq", seq));
    }
}
