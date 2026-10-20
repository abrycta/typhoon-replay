package dev.krtmtthw.typhoon.shared.web;

import java.io.IOException;
import java.util.List;
import java.util.Map;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpServletResponseWrapper;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import dev.krtmtthw.typhoon.shared.ContractDocument;
import dev.krtmtthw.typhoon.shared.TrProperties;
import dev.krtmtthw.typhoon.shared.problem.ApiException;
import dev.krtmtthw.typhoon.shared.problem.ProblemType;
import dev.krtmtthw.typhoon.shared.problem.ProblemWriter;

/**
 * First filter of every request: assigns the request id, sets the headers every response carries
 * (CONTRACT-GUIDE §4) before anything can fail, and writes one structured access-log line per request
 * ({@code ts, level, msg, requestId, impl, method, path, status, durMs}; never cookies, tokens or OAuth codes,
 * which is why only the path, not the query, is logged).
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class ContractHeadersFilter extends OncePerRequestFilter {

    private static final Logger ACCESS = LoggerFactory.getLogger("access");

    private final RequestContext.StandardHeaders standard;
    private final ContractRoutes routes;
    private final ProblemWriter problems;

    public ContractHeadersFilter(TrProperties props, ContractDocument contract, ContractRoutes routes, ProblemWriter problems) {
        this.standard = new RequestContext.StandardHeaders(props.impl(), contract.implVersion(), contract.contractVersion());
        this.routes = routes;
        this.problems = problems;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        long started = System.nanoTime();
        String requestId = RequestContext.resolveRequestId(request.getHeader("X-Request-Id"));
        request.setAttribute(RequestContext.REQUEST_ID, requestId);
        request.setAttribute(RequestContext.STANDARD_HEADERS, standard);
        RequestContext.applyStandardHeaders(request, response);
        MDC.put("requestId", requestId);
        try {
            var allow = routes.disallowed(request.getMethod(), RequestContext.path(request));
            if (allow.isPresent()) {
                problems.write(request, response, new ApiException(ProblemType.METHOD_NOT_ALLOWED,
                        "Method " + request.getMethod() + " is not supported here.", List.of(), Map.of("Allow", allow.get())));
                return;
            }
            LenientQueryRequest lenient = new LenientQueryRequest(request);
            var empty = routes.emptyParameter(request.getMethod(), RequestContext.path(request), lenient.getParameterMap());
            if (empty.isPresent()) {
                problems.write(request, response, ApiException.validation("#/query/" + empty.get(), "must not be empty"));
                return;
            }
            chain.doFilter(lenient, new JsonCharsetResponse(response));
        } finally {
            MDC.put("method", request.getMethod());
            MDC.put("path", RequestContext.path(request));
            MDC.put("status", Integer.toString(response.getStatus()));
            MDC.put("durMs", Long.toString((System.nanoTime() - started) / 1_000_000));
            ACCESS.info(request.isAsyncStarted() ? "stream opened" : "request");
            MDC.clear();
        }
    }

    /** {@code Content-Type: application/json; charset=utf-8} as CONTRACT-GUIDE §4 lists it. */
    static final class JsonCharsetResponse extends HttpServletResponseWrapper {

        JsonCharsetResponse(HttpServletResponse response) {
            super(response);
        }

        @Override
        public void setContentType(String type) {
            super.setContentType(withCharset(type));
        }

        @Override
        public void setHeader(String name, String value) {
            super.setHeader(name, "Content-Type".equalsIgnoreCase(name) ? withCharset(value) : value);
        }

        @Override
        public void addHeader(String name, String value) {
            super.addHeader(name, "Content-Type".equalsIgnoreCase(name) ? withCharset(value) : value);
        }

        private static String withCharset(String type) {
            if (type != null && type.startsWith("application/json") && !type.contains("charset")) {
                return "application/json; charset=utf-8";
            }
            return type;
        }
    }
}
