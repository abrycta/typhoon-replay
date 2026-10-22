package dev.krtmtthw.typhoon.shared.web;

import java.io.IOException;
import java.nio.charset.StandardCharsets;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import dev.krtmtthw.typhoon.shared.TrProperties;

/**
 * When {@code TR_EDGE_SECRET} is set, {@code /v1/*} answers only requests that carry it in {@code X-Edge-Secret}
 * (the edge proxy adds it). A direct call to the Render URL would skip the edge cache and its per-IP limit and spend
 * Render's shared egress, so it gets a small 403 instead. {@code /healthz} and {@code /readyz} stay open. Runs after
 * {@link ContractHeadersFilter}, so the 403 still carries the request id and the §4 headers.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 5)
public class EdgeSecretFilter extends OncePerRequestFilter {

    private static final byte[] BODY = ("{\"type\":\"about:blank\",\"title\":\"Forbidden\",\"status\":403,"
            + "\"detail\":\"Requests must come through the site's edge proxy.\"}").getBytes(StandardCharsets.UTF_8);

    private final byte[] secret;

    public EdgeSecretFilter(TrProperties props) {
        this.secret = props.edgeSecretBytes();
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return secret == null || !RequestContext.path(request).startsWith("/v1/");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        if (!RateLimitFilter.fromEdge(request, secret)) {
            response.setStatus(HttpServletResponse.SC_FORBIDDEN);
            response.setHeader("Cache-Control", "no-store");
            response.setContentType("application/problem+json");
            response.setContentLength(BODY.length);
            response.getOutputStream().write(BODY);
            return;
        }
        chain.doFilter(request, response);
    }
}
