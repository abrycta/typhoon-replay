package dev.krtmtthw.typhoon.shared.web;

import java.io.IOException;
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
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
public class RateLimitFilter extends OncePerRequestFilter {

    private static final Duration WINDOW = Duration.ofMinutes(1);

    private final int perMinute;
    private final String policy;
    private final ProblemWriter problems;
    private final Cache<String, Bucket> buckets = Caffeine.newBuilder()
            .maximumSize(50_000)
            .expireAfterAccess(Duration.ofMinutes(2))
            .build();

    public RateLimitFilter(TrProperties props, ProblemWriter problems) {
        this.perMinute = props.rateLimitPerMinute();
        this.policy = "\"per-ip\";q=" + perMinute + ";w=" + WINDOW.toSeconds();
        this.problems = problems;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = RequestContext.path(request);
        return perMinute <= 0 || path.equals("/healthz") || path.equals("/readyz");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        Bucket bucket = buckets.get(clientIp(request), ip -> Bucket.builder()
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

    /** The client address as the edge proxy reports it (Cloudflare first, then the left-most X-Forwarded-For). */
    static String clientIp(HttpServletRequest request) {
        String cf = request.getHeader("CF-Connecting-IP");
        if (cf != null && !cf.isBlank()) {
            return cf.trim();
        }
        String xff = request.getHeader("X-Forwarded-For");
        if (xff != null && !xff.isBlank()) {
            int comma = xff.indexOf(',');
            return (comma < 0 ? xff : xff.substring(0, comma)).trim();
        }
        return request.getRemoteAddr();
    }
}
