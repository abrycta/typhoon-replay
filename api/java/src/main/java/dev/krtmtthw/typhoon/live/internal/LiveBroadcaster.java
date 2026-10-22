package dev.krtmtthw.typhoon.live.internal;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import dev.krtmtthw.typhoon.contract.model.LiveSnapshot;
import dev.krtmtthw.typhoon.shared.TrProperties;
import dev.krtmtthw.typhoon.shared.problem.ApiException;
import dev.krtmtthw.typhoon.shared.problem.ProblemType;
import tools.jackson.databind.json.JsonMapper;

/**
 * Fans {@code live.live_event} rows out to SSE subscribers (CONTRACT-GUIDE §7).
 *
 * <ul>
 *   <li>Each stream starts with {@code retry: 10000} and either a snapshot (id = {@code live.revision.seq}) or, when
 *       {@code Last-Event-ID} is inside the retained window, the missed events in {@code seq} order.</li>
 *   <li>One poller thread (a virtual thread) checks {@code live.revision} every second, but only while at least one
 *       client is connected: with no subscribers the thread ends, so no DB connection is held and Neon can suspend.
 *       LISTEN/NOTIFY is not available through the transaction-mode pooler.</li>
 *   <li>A {@code :} comment heartbeat goes to any stream that has been silent for 15 s.</li>
 *   <li>One client address may hold at most {@code TR_MAX_STREAMS_PER_CLIENT} streams (429 {@code rate-limited}
 *       above it), so a single client cannot fill every slot of the instance-wide cap.</li>
 * </ul>
 */
@Component
public class LiveBroadcaster {

    private static final Logger LOG = LoggerFactory.getLogger(LiveBroadcaster.class);
    private static final long RETRY_MS = 10_000;
    private static final Duration POLL = Duration.ofSeconds(1);
    private static final long HEARTBEAT_NANOS = Duration.ofSeconds(15).toNanos();
    private static final Duration STREAM_LIFETIME = Duration.ofMinutes(30);
    private static final MediaType UTF8_TEXT = new MediaType(MediaType.TEXT_PLAIN, StandardCharsets.UTF_8);

    private final LiveQueries live;
    private final JsonMapper json;
    private final int maxStreams;
    private final int maxPerClient;
    private final Set<Subscriber> subscribers = ConcurrentHashMap.newKeySet();
    private final Object pollerLock = new Object();
    private boolean polling;

    public LiveBroadcaster(LiveQueries live, JsonMapper json, TrProperties props) {
        this.live = live;
        this.json = json;
        this.maxStreams = Math.max(50, props.maxStreams());
        this.maxPerClient = props.maxStreamsPerClient();
    }

    /** Opens a stream for {@code client} (its address). {@code lastEventId} is null for a fresh client. */
    public SseEmitter open(Long lastEventId, String client) {
        if (subscribers.size() >= maxStreams) {
            throw new ApiException(ProblemType.STREAM_CAPACITY, "Too many live streams on this instance; retry shortly.",
                    List.of(), Map.of("Retry-After", "10"));
        }
        if (maxPerClient > 0 && subscribers.stream().filter(s -> s.client.equals(client)).count() >= maxPerClient) {
            throw new ApiException(ProblemType.RATE_LIMITED, "Too many live streams from this address; close one first.",
                    List.of(), Map.of("Retry-After", "10"));
        }
        // Decide snapshot vs resume before registering, so a failing database gives a problem response, not a broken stream.
        boolean resume = lastEventId != null && live.inWindow(lastEventId);
        LiveSnapshot snapshot = resume ? null : live.snapshot();

        SseEmitter emitter = new SseEmitter(STREAM_LIFETIME.toMillis());
        Subscriber sub = new Subscriber(emitter, client);
        emitter.onCompletion(() -> subscribers.remove(sub));
        emitter.onTimeout(() -> {
            subscribers.remove(sub);
            emitter.complete();
        });
        emitter.onError(e -> subscribers.remove(sub));

        synchronized (sub) {
            subscribers.add(sub);
            ensurePolling();
            if (resume) {
                sub.send(SseEmitter.event().reconnectTime(RETRY_MS));
                sub.lastSent = lastEventId;
                deliver(sub, live.eventsAfter(lastEventId, 1000));
            } else {
                sub.send(SseEmitter.event().reconnectTime(RETRY_MS).id(Long.toString(snapshot.getSeq()))
                        .name("snapshot").data(json.writeValueAsString(snapshot), UTF8_TEXT));
                sub.lastSent = snapshot.getSeq();
            }
        }
        return emitter;
    }

    public int connected() {
        return subscribers.size();
    }

    private void ensurePolling() {
        synchronized (pollerLock) {
            if (!polling) {
                polling = true;
                Thread.ofVirtual().name("live-poller").start(this::poll);
            }
        }
    }

    private void poll() {
        long seen = -1;
        while (true) {
            synchronized (pollerLock) {
                if (subscribers.isEmpty()) {
                    polling = false;
                    return;
                }
            }
            try {
                long revision = live.revision();
                if (revision != seen) {
                    long from = subscribers.stream().mapToLong(s -> s.lastSent).min().orElse(revision);
                    if (from < revision) {
                        List<LiveQueries.Event> events = live.eventsAfter(from, 1000);
                        for (Subscriber sub : subscribers) {
                            synchronized (sub) {
                                deliver(sub, events);
                            }
                        }
                    }
                    seen = revision;
                }
            } catch (RuntimeException e) {
                LOG.warn("live poll failed: {}", e.getMessage());
            }
            long now = System.nanoTime();
            for (Subscriber sub : subscribers) {
                if (now - sub.lastWrite >= HEARTBEAT_NANOS) {
                    synchronized (sub) {
                        sub.send(SseEmitter.event().comment(""));
                    }
                }
            }
            try {
                Thread.sleep(POLL);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                synchronized (pollerLock) {
                    polling = false;
                }
                return;
            }
        }
    }

    /** Sends the events this subscriber has not seen yet, in order. Caller holds the subscriber's lock. */
    private void deliver(Subscriber sub, List<LiveQueries.Event> events) {
        for (LiveQueries.Event e : events) {
            if (e.seq() > sub.lastSent && sub.open) {
                sub.send(SseEmitter.event().id(Long.toString(e.seq())).name(e.type()).data(e.payload(), UTF8_TEXT));
                sub.lastSent = e.seq();
            }
        }
    }

    private final class Subscriber {

        final SseEmitter emitter;
        final String client;
        volatile long lastSent;
        volatile long lastWrite = System.nanoTime();
        volatile boolean open = true;

        Subscriber(SseEmitter emitter, String client) {
            this.emitter = emitter;
            this.client = client;
        }

        void send(SseEmitter.SseEventBuilder event) {
            if (!open) {
                return;
            }
            try {
                emitter.send(event);
                lastWrite = System.nanoTime();
            } catch (IOException | IllegalStateException e) {
                open = false;
                subscribers.remove(this);
                emitter.completeWithError(e);
            }
        }
    }
}
