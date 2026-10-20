package dev.krtmtthw.typhoon.shared.problem;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.http.HttpHeaders;
import org.springframework.stereotype.Component;

import dev.krtmtthw.typhoon.shared.web.CachePolicy;
import dev.krtmtthw.typhoon.shared.web.RequestContext;
import tools.jackson.databind.json.JsonMapper;

/**
 * Writes RFC 9457 problem documents straight to the servlet response, so filters (rate limit, body size, CSRF,
 * authentication) and the MVC exception handler produce byte-for-byte the same shape. Never includes stack traces
 * or SQL: {@code detail} is always a message written by this application.
 */
@Component
public class ProblemWriter {

    public static final String MEDIA_TYPE = "application/problem+json";

    private final JsonMapper json;

    public ProblemWriter(JsonMapper json) {
        this.json = json;
    }

    public void write(HttpServletRequest request, HttpServletResponse response, ApiException e) throws IOException {
        write(request, response, e.type(), e.getMessage(), e.errors(), e.headers());
    }

    public void write(HttpServletRequest request, HttpServletResponse response, ProblemType type, String detail)
            throws IOException {
        write(request, response, type, detail, List.of(), Map.of());
    }

    public void write(HttpServletRequest request, HttpServletResponse response, ProblemType type, String detail,
            List<ApiException.FieldProblem> errors, Map<String, String> headers) throws IOException {
        if (response.isCommitted()) {
            return;
        }
        // Drop a partially built success response (ETag, Link, Location...), then restore the §4 headers.
        response.reset();
        RequestContext.applyStandardHeaders(request, response);
        response.setStatus(type.status());
        response.setContentType(MEDIA_TYPE);
        response.setCharacterEncoding("UTF-8");
        String path = RequestContext.path(request);
        response.setHeader(HttpHeaders.CACHE_CONTROL, CachePolicy.forError(type.status(), request.getMethod(), path));
        headers.forEach(response::setHeader);
        response.getOutputStream().write(json.writeValueAsBytes(body(request, type, detail, errors)));
        response.flushBuffer();
    }

    /** The problem document as an ordered map (no nulls: optional members are omitted). */
    public Map<String, Object> body(HttpServletRequest request, ProblemType type, String detail,
            List<ApiException.FieldProblem> errors) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("type", type.typeUri());
        body.put("title", type.title());
        body.put("status", type.status());
        if (detail != null && !detail.isBlank()) {
            body.put("detail", detail);
        }
        body.put("instance", RequestContext.instance(request));
        body.put("code", type.code());
        body.put("requestId", RequestContext.requestId(request));
        if (!errors.isEmpty()) {
            body.put("errors", errors.stream().limit(50)
                    .map(e -> Map.of("pointer", e.pointer(), "detail", e.detail() == null ? "invalid" : e.detail()))
                    .toList());
        }
        return body;
    }
}
