package dev.krtmtthw.typhoon.shared.web;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;

import jakarta.servlet.http.HttpServletRequest;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

/**
 * Data-derived weak ETags (CONTRACT-GUIDE §6), identical across the four backends because they hash the request,
 * never the response bytes.
 */
public final class Etags {

    private Etags() {}

    /**
     * {@code W/"d{datasetVersion}-{resourceKey}"}: {@code resourceKey} is the first 16 hex digits of SHA-256 over the
     * canonical request string: the path as served, then {@code ?} and the recognised query parameters that were
     * sent, sorted by name then value, RFC 3986 percent-encoded, joined by {@code &}. Unknown parameters are dropped
     * and defaults are not filled in.
     */
    public static String catalogue(long datasetVersion, HttpServletRequest request, Collection<String> recognised) {
        return "W/\"d" + datasetVersion + "-" + resourceKey(canonicalRequest(request, recognised)) + "\"";
    }

    public static String canonicalRequest(HttpServletRequest request, Collection<String> recognised) {
        List<String[]> pairs = new ArrayList<>();
        for (Map.Entry<String, String[]> e : request.getParameterMap().entrySet()) {
            if (recognised.contains(e.getKey())) {
                for (String value : e.getValue()) {
                    pairs.add(new String[] {e.getKey(), value});
                }
            }
        }
        String path = RequestContext.path(request);
        if (pairs.isEmpty()) {
            return path;
        }
        pairs.sort((a, b) -> {
            int byName = a[0].compareTo(b[0]);
            return byName != 0 ? byName : a[1].compareTo(b[1]);
        });
        StringBuilder sb = new StringBuilder(path).append('?');
        for (int i = 0; i < pairs.size(); i++) {
            if (i > 0) {
                sb.append('&');
            }
            sb.append(percentEncode(pairs.get(i)[0])).append('=').append(percentEncode(pairs.get(i)[1]));
        }
        return sb.toString();
    }

    public static String resourceKey(String canonical) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(canonical.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest).substring(0, 16);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** RFC 3986: unreserved characters literal, everything else as UTF-8 bytes in uppercase hex. */
    public static String percentEncode(String value) {
        StringBuilder sb = new StringBuilder();
        for (byte b : value.getBytes(StandardCharsets.UTF_8)) {
            int c = b & 0xFF;
            if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
                    || c == '-' || c == '.' || c == '_' || c == '~') {
                sb.append((char) c);
            } else {
                sb.append('%').append(Character.toUpperCase(Character.forDigit(c >> 4, 16)))
                        .append(Character.toUpperCase(Character.forDigit(c & 0xF, 16)));
            }
        }
        return sb.toString();
    }

    /** Weak comparison of an {@code If-None-Match} list (or {@code *}) against our tag. */
    public static boolean matches(String ifNoneMatch, String etag) {
        if (ifNoneMatch == null || ifNoneMatch.isBlank()) {
            return false;
        }
        String ours = opaque(etag);
        for (String candidate : ifNoneMatch.split(",")) {
            String c = candidate.trim();
            if (c.equals("*") || (!c.isEmpty() && opaque(c).equals(ours))) {
                return true;
            }
        }
        return false;
    }

    private static String opaque(String tag) {
        return tag.startsWith("W/") ? tag.substring(2) : tag;
    }

    /** 304 with the same ETag (and the Cache-Control the request filter already set), no body. */
    public static <T> ResponseEntity<T> notModified(String etag) {
        return ResponseEntity.status(HttpStatus.NOT_MODIFIED).eTag(etag).build();
    }
}
