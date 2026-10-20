package dev.krtmtthw.typhoon.shared.web;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Pattern;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.http.HttpHeaders;

/**
 * Per-request values shared by filters, controllers and the problem writer: the request id, the headers every
 * response carries (CONTRACT-GUIDE §4), and the browser-visible base built from {@code X-Forwarded-Prefix}.
 */
public final class RequestContext {

    static final String REQUEST_ID = "tr.requestId";
    static final String STANDARD_HEADERS = "tr.standardHeaders";
    static final String STICKY_HEADERS = "tr.stickyHeaders";

    private static final Pattern REQUEST_ID_SHAPE = Pattern.compile("[A-Za-z0-9._-]{1,64}");
    private static final Pattern PREFIX_SHAPE = Pattern.compile("(/[A-Za-z0-9._-]+){1,4}");

    private RequestContext() {}

    /** The inbound {@code X-Request-Id} when it has the allowed shape, else a fresh UUIDv7. */
    static String resolveRequestId(String inbound) {
        return inbound != null && REQUEST_ID_SHAPE.matcher(inbound).matches() ? inbound : UuidV7.next().toString();
    }

    public static String requestId(HttpServletRequest request) {
        Object id = request.getAttribute(REQUEST_ID);
        return id != null ? id.toString() : UuidV7.next().toString();
    }

    /** The request path inside this application (what the contract calls "the path as served"). */
    public static String path(HttpServletRequest request) {
        String uri = request.getRequestURI();
        String context = request.getContextPath();
        return context.isEmpty() ? uri : uri.substring(context.length());
    }

    /** Path and query as received: the problem {@code instance}. */
    public static String instance(HttpServletRequest request) {
        String query = request.getQueryString();
        return query == null ? request.getRequestURI() : request.getRequestURI() + "?" + query;
    }

    /** {@code X-Forwarded-Prefix} set by the edge proxy (e.g. {@code /api/java}), or empty when absent or malformed. */
    public static String forwardedPrefix(HttpServletRequest request) {
        String prefix = request.getHeader("X-Forwarded-Prefix");
        if (prefix == null || prefix.isEmpty()) {
            return "";
        }
        if (prefix.endsWith("/")) {
            prefix = prefix.substring(0, prefix.length() - 1);
        }
        return PREFIX_SHAPE.matcher(prefix).matches() ? prefix : "";
    }

    /** A response header that must survive a reset by the problem writer (e.g. the rate-limit headers). */
    public static void stickyHeader(HttpServletRequest request, HttpServletResponse response, String name, String value) {
        @SuppressWarnings("unchecked")
        Map<String, String> sticky = (Map<String, String>) request.getAttribute(STICKY_HEADERS);
        if (sticky == null) {
            sticky = new LinkedHashMap<>();
            request.setAttribute(STICKY_HEADERS, sticky);
        }
        sticky.put(name, value);
        response.setHeader(name, value);
    }

    /** Sets the §4 headers (and any sticky headers); used up front and again after a response reset. */
    public static void applyStandardHeaders(HttpServletRequest request, HttpServletResponse response) {
        if (request.getAttribute(STANDARD_HEADERS) instanceof StandardHeaders h) {
            response.setHeader("X-Backend-Impl", h.impl());
            response.setHeader("X-Backend-Version", h.implVersion());
            response.setHeader("X-Contract-Version", h.contractVersion());
        }
        response.setHeader("X-Request-Id", requestId(request));
        String path = path(request);
        response.setHeader(HttpHeaders.VARY, "Accept-Encoding");
        response.setHeader(HttpHeaders.CACHE_CONTROL, CachePolicy.forSuccess(path));
        // The hardening headers Spring Security used to add; harmless on JSON and kept on every response.
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("X-Frame-Options", "DENY");
        response.setHeader("X-XSS-Protection", "0");
        if (request.getAttribute(STICKY_HEADERS) instanceof Map<?, ?> sticky) {
            sticky.forEach((k, v) -> response.setHeader(k.toString(), v.toString()));
        }
    }

    record StandardHeaders(String impl, String implVersion, String contractVersion) {}
}
