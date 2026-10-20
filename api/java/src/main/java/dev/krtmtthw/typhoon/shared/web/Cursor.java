package dev.krtmtthw.typhoon.shared.web;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

import dev.krtmtthw.typhoon.shared.problem.ApiException;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Interchangeable keyset cursors (CONTRACT-GUIDE §5): {@code base64url} (no padding) of the UTF-8 JSON array
 * {@code [1, "<sort>", <keysetValue...>, "<lastId>"]}. Any backend's cursor works here: keyset numbers are compared
 * as JSON values ({@code 27} equals {@code 27.0}), and encoding writes the shortest number form.
 *
 * @param sort    the sort the cursor was made for
 * @param keyset  keyset values, {@link BigDecimal} or {@link String}
 * @param lastId  id of the last item of the previous page (the tie-breaker)
 */
public record Cursor(String sort, List<Object> keyset, String lastId) {

    private static final JsonMapper JSON = JsonMapper.builder().build();

    /** What a keyset value must look like. */
    public enum Kind { NUMBER, STRING, TIMESTAMP }

    public String encode() {
        StringBuilder sb = new StringBuilder("[1,").append(JSON.writeValueAsString(sort));
        for (Object k : keyset) {
            sb.append(',');
            sb.append(k instanceof BigDecimal n ? shortest(n) : JSON.writeValueAsString(k.toString()));
        }
        sb.append(',').append(JSON.writeValueAsString(lastId)).append(']');
        return Base64.getUrlEncoder().withoutPadding().encodeToString(sb.toString().getBytes(StandardCharsets.UTF_8));
    }

    public static String encode(String sort, Object keysetValue, String lastId) {
        return new Cursor(sort, List.of(keysetValue), lastId).encode();
    }

    /**
     * Decodes and checks a cursor for {@code expectedSort}; a malformed cursor, or one made for another sort, is
     * 400 {@code invalid-cursor}. Returns null when {@code raw} is null.
     */
    public static Cursor decode(String raw, String expectedSort, Kind... kinds) {
        if (raw == null) {
            return null;
        }
        JsonNode array;
        try {
            byte[] bytes = Base64.getUrlDecoder().decode(raw);
            array = JSON.readTree(new String(bytes, StandardCharsets.UTF_8));
        } catch (IllegalArgumentException | JacksonException e) {
            throw ApiException.invalidCursor("cursor is not base64url JSON");
        }
        if (array == null || !array.isArray() || array.size() != kinds.length + 3) {
            throw ApiException.invalidCursor("cursor has the wrong shape");
        }
        if (!array.get(0).isNumber() || array.get(0).decimalValue().compareTo(BigDecimal.ONE) != 0) {
            throw ApiException.invalidCursor("unknown cursor version");
        }
        if (!array.get(1).isString() || !array.get(1).asString().equals(expectedSort)) {
            throw ApiException.invalidCursor("cursor was made for another sort");
        }
        List<Object> keyset = new ArrayList<>(kinds.length);
        for (int i = 0; i < kinds.length; i++) {
            JsonNode v = array.get(i + 2);
            switch (kinds[i]) {
                case NUMBER -> {
                    if (!v.isNumber()) {
                        throw ApiException.invalidCursor("cursor keyset must be a number");
                    }
                    keyset.add(v.decimalValue());
                }
                case STRING -> {
                    if (!v.isString()) {
                        throw ApiException.invalidCursor("cursor keyset must be a string");
                    }
                    keyset.add(v.asString());
                }
                case TIMESTAMP -> {
                    if (!v.isString()) {
                        throw ApiException.invalidCursor("cursor keyset must be an RFC 3339 timestamp");
                    }
                    try {
                        keyset.add(OffsetDateTime.parse(v.asString()));
                    } catch (DateTimeParseException e) {
                        throw ApiException.invalidCursor("cursor keyset must be an RFC 3339 timestamp");
                    }
                }
            }
        }
        JsonNode last = array.get(array.size() - 1);
        if (!last.isString() || last.asString().isEmpty() || last.asString().length() > 64) {
            throw ApiException.invalidCursor("cursor id must be a string");
        }
        return new Cursor(expectedSort, keyset, last.asString());
    }

    public BigDecimal number(int i) {
        return (BigDecimal) keyset.get(i);
    }

    public String string(int i) {
        return (String) keyset.get(i);
    }

    public OffsetDateTime timestamp(int i) {
        return (OffsetDateTime) keyset.get(i);
    }

    private static String shortest(BigDecimal n) {
        BigDecimal stripped = n.stripTrailingZeros();
        return stripped.scale() < 0 ? stripped.setScale(0).toPlainString() : stripped.toPlainString();
    }
}
