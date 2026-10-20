package dev.krtmtthw.typhoon.accounts.internal.security;

import java.io.IOException;
import java.util.List;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.http.HttpMethod;
import org.springframework.security.web.servlet.util.matcher.PathPatternRequestMatcher;
import org.springframework.security.web.util.matcher.OrRequestMatcher;
import org.springframework.security.web.util.matcher.RequestMatcher;
import org.springframework.web.filter.OncePerRequestFilter;

import dev.krtmtthw.typhoon.shared.problem.ProblemType;
import dev.krtmtthw.typhoon.shared.problem.ProblemWriter;

/**
 * The contract's CSRF rule (CONTRACT-GUIDE §9) for the unsafe operations: {@code Origin} must equal
 * {@code TR_SITE_ORIGIN} (or one of {@code TR_ALLOWED_ORIGINS}) and {@code X-Requested-With} must be {@code typhoon-replay}, else 403 {@code csrf}.
 *
 * <p>This replaces Spring Security's token-based {@code csrf.spa()}: every backend must accept the same request, and
 * the agreed scheme is header-based, with {@code SameSite=Lax} on the session cookie. Only the contract's unsafe
 * operations are matched, so an unsupported method elsewhere still gets 405, and the test hooks are exempt.
 */
class OriginCsrfFilter extends OncePerRequestFilter {

    static final String HEADER = "X-Requested-With";
    static final String VALUE = "typhoon-replay";

    private static final PathPatternRequestMatcher.Builder PATHS = PathPatternRequestMatcher.withDefaults();
    static final RequestMatcher UNSAFE_OPERATIONS = new OrRequestMatcher(List.of(
            PATHS.matcher(HttpMethod.POST, "/v1/auth/logout"),
            PATHS.matcher(HttpMethod.DELETE, "/v1/me"),
            PATHS.matcher(HttpMethod.POST, "/v1/me/places"),
            PATHS.matcher(HttpMethod.PATCH, "/v1/me/places/{id}"),
            PATHS.matcher(HttpMethod.DELETE, "/v1/me/places/{id}"),
            PATHS.matcher(HttpMethod.PUT, "/v1/me/alerts")));

    private final java.util.Set<String> origins;
    private final ProblemWriter problems;

    OriginCsrfFilter(java.util.Set<String> origins, ProblemWriter problems) {
        this.origins = java.util.Set.copyOf(origins);
        this.problems = problems;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return !UNSAFE_OPERATIONS.matches(request);
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String origin = request.getHeader("Origin");
        if (origin == null || !origins.contains(origin)) {
            problems.write(request, response, ProblemType.CSRF, "Origin must be the site origin.");
            return;
        }
        if (!VALUE.equals(request.getHeader(HEADER))) {
            problems.write(request, response, ProblemType.CSRF, "X-Requested-With: typhoon-replay is required.");
            return;
        }
        chain.doFilter(request, response);
    }
}
