package dev.krtmtthw.typhoon.live.internal;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import dev.krtmtthw.typhoon.contract.model.ActiveStorm;
import dev.krtmtthw.typhoon.contract.model.LiveSnapshot;
import dev.krtmtthw.typhoon.shared.catalog.CatalogRows;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

/**
 * Reads of the live schema. Writes happen only through {@code live.apply_event()} (CONTRACT-GUIDE §7), here only from
 * the test hook.
 */
@Repository
public class LiveQueries {

    private static final TypeReference<List<ActiveStorm>> STORMS = new TypeReference<>() {};

    private final JdbcClient jdbc;
    private final JsonMapper json;

    public LiveQueries(JdbcClient jdbc, JsonMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    /** Revision and active storms read in one statement, so {@code seq} matches {@code storms} exactly. */
    public LiveSnapshot snapshot() {
        return jdbc.sql("""
                SELECT r.seq, r.updated_at,
                       (SELECT coalesce(json_agg(a.storm ORDER BY a.live_id), '[]'::json) FROM live.active_storm a)::text AS storms
                FROM live.revision r WHERE r.singleton""").query((rs, n) -> {
            long seq = rs.getLong("seq");
            OffsetDateTime asOf = seq > 0 ? CatalogRows.timestamp(rs, "updated_at") : OffsetDateTime.now(ZoneOffset.UTC);
            List<ActiveStorm> storms = json.readValue(rs.getString("storms"), STORMS);
            return new LiveSnapshot(asOf, seq, storms);
        }).single();
    }

    /** {@code live.revision.seq}: the newest applied event. */
    public long revision() {
        return jdbc.sql("SELECT seq FROM live.revision WHERE singleton").query(Long.class).single();
    }

    /** The resume window: {@code oldest retained seq - 1 <= id <= revision}. */
    public boolean inWindow(long lastEventId) {
        return jdbc.sql("""
                SELECT :id BETWEEN coalesce((SELECT min(seq) FROM live.live_event), r.seq + 1) - 1 AND r.seq
                FROM live.revision r WHERE r.singleton""").param("id", lastEventId).query(Boolean.class).single();
    }

    /** Events after {@code seq}, oldest first; {@code payload} is the SSE data JSON exactly as stored. */
    public List<Event> eventsAfter(long seq, int max) {
        return jdbc.sql("SELECT seq, type, payload::text AS payload FROM live.live_event WHERE seq > :seq ORDER BY seq LIMIT :max")
                .param("seq", seq).param("max", max)
                .query((rs, n) -> new Event(rs.getLong("seq"), rs.getString("type"), rs.getString("payload")))
                .list();
    }

    /** Test hook only: the same write path as the ingestion job. */
    public long apply(String type, String payloadJson) {
        return jdbc.sql("SELECT live.apply_event(:type, CAST(:payload AS jsonb))")
                .param("type", type).param("payload", payloadJson).query(Long.class).single();
    }

    public record Event(long seq, String type, String payload) {}
}
