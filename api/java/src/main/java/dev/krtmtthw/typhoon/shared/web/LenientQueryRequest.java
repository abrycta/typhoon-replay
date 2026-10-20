package dev.krtmtthw.typhoon.shared.web;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;

/**
 * Query parameters parsed leniently from the query string. Tomcat 11 throws on malformed chunks (an empty name,
 * broken percent-encoding), but the contract is a tolerant reader: unknown or malformed parameters are dropped,
 * never a 500. This API accepts JSON bodies only, so form parameters are never read.
 */
final class LenientQueryRequest extends HttpServletRequestWrapper {

    private final Map<String, String[]> params;

    LenientQueryRequest(HttpServletRequest request) {
        super(request);
        this.params = Collections.unmodifiableMap(parse(request.getQueryString()));
    }

    static Map<String, String[]> parse(String query) {
        Map<String, List<String>> collected = new LinkedHashMap<>();
        if (query != null) {
            for (String chunk : query.split("&")) {
                if (chunk.isEmpty()) {
                    continue;
                }
                int eq = chunk.indexOf('=');
                String name = decode(eq < 0 ? chunk : chunk.substring(0, eq));
                String value = eq < 0 ? "" : decode(chunk.substring(eq + 1));
                if (name == null || name.isEmpty() || value == null) {
                    continue;
                }
                collected.computeIfAbsent(name, k -> new ArrayList<>()).add(value);
            }
        }
        Map<String, String[]> out = new LinkedHashMap<>();
        collected.forEach((k, v) -> out.put(k, v.toArray(String[]::new)));
        return out;
    }

    /** {@code application/x-www-form-urlencoded} decoding as UTF-8; null when malformed. */
    private static String decode(String s) {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '+') {
                bytes.write(' ');
            } else if (c == '%') {
                if (i + 2 >= s.length()) {
                    return null;
                }
                int hi = Character.digit(s.charAt(i + 1), 16);
                int lo = Character.digit(s.charAt(i + 2), 16);
                if (hi < 0 || lo < 0) {
                    return null;
                }
                bytes.write((hi << 4) | lo);
                i += 2;
            } else {
                byte[] b = String.valueOf(c).getBytes(StandardCharsets.UTF_8);
                bytes.write(b, 0, b.length);
            }
        }
        var decoder = StandardCharsets.UTF_8.newDecoder();
        try {
            return decoder.decode(java.nio.ByteBuffer.wrap(bytes.toByteArray())).toString();
        } catch (java.nio.charset.CharacterCodingException e) {
            return null;
        }
    }

    @Override
    public String getParameter(String name) {
        String[] v = params.get(name);
        return v == null ? null : v[0];
    }

    @Override
    public Map<String, String[]> getParameterMap() {
        return params;
    }

    @Override
    public Enumeration<String> getParameterNames() {
        return Collections.enumeration(params.keySet());
    }

    @Override
    public String[] getParameterValues(String name) {
        String[] v = params.get(name);
        return v == null ? null : v.clone();
    }
}
