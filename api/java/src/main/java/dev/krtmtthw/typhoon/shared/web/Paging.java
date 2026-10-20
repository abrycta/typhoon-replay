package dev.krtmtthw.typhoon.shared.web;

import java.util.function.Function;

import jakarta.servlet.http.HttpServletRequest;

import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Component;

import dev.krtmtthw.typhoon.shared.TrProperties;

/**
 * Page responses: catalogue {@code Cache-Control} (set by the request filter), the dataset ETag, and
 * {@code Link: <...>; rel="next"} built from the browser-visible base ({@code TR_SITE_ORIGIN} +
 * {@code X-Forwarded-Prefix}) whenever the body carries {@code nextCursor} (CONTRACT-GUIDE §5).
 */
@Component
public class Paging {

    private final String siteOrigin;

    public Paging(TrProperties props) {
        this.siteOrigin = props.siteOrigin();
    }

    /** The browser-visible base, e.g. {@code https://typhoon-replay.pages.dev/api/java}. */
    public String publicBase(HttpServletRequest request) {
        return siteOrigin + RequestContext.forwardedPrefix(request);
    }

    public String nextLink(HttpServletRequest request, String nextCursor) {
        StringBuilder query = new StringBuilder();
        String raw = request.getQueryString();
        if (raw != null) {
            for (String pair : raw.split("&")) {
                if (!pair.isEmpty() && !pair.equals("cursor") && !pair.startsWith("cursor=")) {
                    query.append(query.isEmpty() ? "" : "&").append(pair);
                }
            }
        }
        query.append(query.isEmpty() ? "" : "&").append("cursor=").append(nextCursor);
        return "<" + publicBase(request) + RequestContext.path(request) + "?" + query + ">; rel=\"next\"";
    }

    public <T> ResponseEntity<T> page(HttpServletRequest request, String etag, T body, Function<T, String> nextCursor) {
        ResponseEntity.BodyBuilder builder = ResponseEntity.ok().eTag(etag);
        String next = nextCursor.apply(body);
        if (next != null) {
            builder.header(HttpHeaders.LINK, nextLink(request, next));
        }
        return builder.body(body);
    }
}
