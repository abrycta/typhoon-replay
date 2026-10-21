package dev.krtmtthw.typhoon.shared.web;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;

import dev.krtmtthw.typhoon.shared.TrProperties;
import dev.krtmtthw.typhoon.shared.problem.ApiException;
import dev.krtmtthw.typhoon.shared.problem.ProblemType;
import dev.krtmtthw.typhoon.shared.problem.ProblemWriter;
import io.github.bucket4j.Bandwidth;
import io.github.bucket4j.Bucket;
import io.github.bucket4j.ConsumptionProbe;

/**
 * Per-instance, per-IP token buckets (Bucket4j, in memory). The edge proxy enforces the real per-IP limits
 * (CONTRACT-GUIDE §11); this one protects a single Render instance. Every limited response carries the IETF
 * {@code RateLimit} / {@code RateLimit-Policy} headers; an empty bucket gives 429 {@code rate-limited} with
 * {@code Retry-After}. Buckets live in a bounded Caffeine cache that expires idle clients, so nothing runs in the
 * background.
 *
 * <p>Keyed by the real client address. The edge proxy (edge/src/http.ts) sets {@code X-Forwarded-For} to the
 * visitor's {@code CF-Connecting-IP} and proves itself with {@code X-Edge-Secret} ({@code TR_EDGE_SECRET}). Only then
 * is the left-most {@code X-Forwarded-For} entry used: Cloudflare in front of Render appends hops after it, and on
 * the edge's subrequest {@code CF-Connecting-IP} is the Worker's address, not the visitor's. Any other request
 * (a direct call to the Render URL, or no secret configured) is keyed by the connecting address, so a client cannot
 * pick its own bucket by sending those headers.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
public class RateLimitFilter extends OncePerRequestFilter {

    private static final Duration WINDOW = Duration.ofMinutes(1);

    static final String EDGE_SECRET_HEADER = "X-Edge-Secret";

    private final int perMinute;
    private final String policy;
    private final byte[] edgeSecret;
    private final ProblemWriter problems;
    private final Cache<String, Bucket> buckets = Caffeine.newBuilder()
            .maximumSize(50_000)
            .expireAfterAccess(Duration.ofMinutes(2))
            .build();

    public RateLimitFilter(TrProperties props, ProblemWriter problems) {
        this.perMinute = props.rateLimitPerMinute();
        this.policy = "\"per-ip\";q=" + perMinute + ";w=" + WINDOW.toSeconds();
        this.problems = problems;
        String secret = props.edgeSecret();
        this.edgeSecret = secret == null || secret.isBlank() ? null : secret.trim().getBytes(StandardCharsets.UTF_8);
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = RequestContext.path(request);
        return perMinute <= 0 || path.equals("/healthz") || path.equals("/readyz");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        Bucket bucket = buckets.get(clientIp(request, edgeSecret), ip -> Bucket.builder()
                .addLimit(Bandwidth.builder().capacity(perMinute).refillGreedy(perMinute, WINDOW).build())
                .build());
        ConsumptionProbe probe = bucket.tryConsumeAndReturnRemaining(1);
        long remaining = probe.getRemainingTokens();
        long resetSeconds = probe.isConsumed()
                ? (perMinute - remaining) * WINDOW.toSeconds() / perMinute
                : Math.max(1, TimeUnit.NANOSECONDS.toSeconds(probe.getNanosToWaitForRefill()) + 1);
        RequestContext.stickyHeader(request, response, "RateLimit-Policy", policy);
        RequestContext.stickyHeader(request, response, "RateLimit", "\"per-ip\";r=" + remaining + ";t=" + resetSeconds);
        if (!probe.isConsumed()) {
            problems.write(request, response, new ApiException(ProblemType.RATE_LIMITED,
                    "Too many requests from this address; retry later.", java.util.List.of(),
                    Map.of("Retry-After", Long.toString(resetSeconds))));
            return;
        }
        chain.doFilter(request, response);
    }

    /**
     * The client address: the left-most {@code X-Forwarded-For} entry when the request carries the edge secret,
     * otherwise the connecting address. {@code CF-Connecting-IP} is never trusted here (see the class comment).
     */
    static String clientIp(HttpServletRequest request, byte[] edgeSecret) {
        if (fromEdge(request, edgeSecret)) {
            String xff = request.getHeader("X-Forwarded-For");
            if (xff != null && !xff.isBlank()) {
                int comma = xff.indexOf(',');
                String first = (comma < 0 ? xff : xff.substring(0, comma)).trim();
                if (!first.isEmpty()) {
                    return first;
                }
            }
        }
        return request.getRemoteAddr();
    }

    static boolean fromEdge(HttpServletRequest request, byte[] edgeSecret) {
        String sent = request.getHeader(EDGE_SECRET_HEADER);
        return edgeSecret != null && sent != null
                && MessageDigest.isEqual(sent.trim().getBytes(StandardCharsets.UTF_8), edgeSecret);
    }
}
