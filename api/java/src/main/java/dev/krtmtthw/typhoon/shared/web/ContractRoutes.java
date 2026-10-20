package dev.krtmtthw.typhoon.shared.web;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

import org.springframework.stereotype.Component;

import dev.krtmtthw.typhoon.shared.ContractDocument;
import tools.jackson.databind.JsonNode;

/**
 * The contract's paths and their methods, read from the bundle. Used to answer any method the contract does not list
 * for a path with 405 {@code method-not-allowed} and an {@code Allow} header (RFC 9110), including methods the
 * servlet container would otherwise handle itself ({@code TRACE}) or not recognise ({@code QUERY}).
 */
@Component
public class ContractRoutes {

    private static final Set<String> HTTP_METHODS = Set.of("get", "put", "post", "delete", "options", "head", "patch", "trace");

    private final List<Route> routes = new ArrayList<>();
    private final JsonNode spec;

    public ContractRoutes(ContractDocument contract) {
        this.spec = contract.tree();
        contract.tree().path("paths").properties().forEach(e -> {
            Set<String> methods = new LinkedHashSet<>();
            Map<String, Set<String>> nonEmpty = new HashMap<>();
            e.getValue().propertyNames().forEach(m -> {
                if (HTTP_METHODS.contains(m)) {
                    methods.add(m.toUpperCase(Locale.ROOT));
                    nonEmpty.put(m.toUpperCase(Locale.ROOT), nonEmptyQueryParams(e.getValue().path(m)));
                }
            });
            if (methods.contains("GET")) {
                methods.add("HEAD");
            }
            methods.add("OPTIONS");
            String regex = Pattern.quote(e.getKey()).replaceAll("\\{[^}/]+}", "\\\\E[^/]+\\\\Q");
            routes.add(new Route(Pattern.compile(regex), Set.copyOf(methods), String.join(", ", methods), Map.copyOf(nonEmpty)));
        });
        // Literal segments win over templates (/v1/places/search before /v1/places/{placeId}).
        routes.sort(java.util.Comparator.comparingInt(r -> r.pattern.pattern().split("\\[\\^/]\\+", -1).length));
    }

    /** Query parameters whose schema cannot be an empty string (numbers, enums, patterns, minLength). */
    private Set<String> nonEmptyQueryParams(JsonNode operation) {
        Set<String> names = new HashSet<>();
        for (JsonNode p : operation.path("parameters")) {
            JsonNode param = resolve(p);
            if (!"query".equals(param.path("in").asString())) {
                continue;
            }
            JsonNode schema = resolve(param.path("schema"));
            String type = schema.path("type").asString("");
            if (type.equals("integer") || type.equals("number") || type.equals("boolean") || schema.has("enum")
                    || schema.has("pattern") || schema.path("minLength").asInt(0) > 0) {
                names.add(param.path("name").asString());
            }
        }
        return names;
    }

    private JsonNode resolve(JsonNode node) {
        JsonNode n = node;
        while (n.has("$ref")) {
            n = spec.at(n.get("$ref").asString().substring(1));
        }
        return n;
    }

    /**
     * The first query parameter sent with an empty value although its schema forbids it. Spring would otherwise
     * treat {@code ?sort=} as absent and apply the default, accepting input the contract rejects.
     */
    public Optional<String> emptyParameter(String method, String path, Map<String, String[]> params) {
        for (Route r : routes) {
            if (r.pattern.matcher(path).matches()) {
                Set<String> nonEmpty = r.nonEmpty.getOrDefault(method, Set.of());
                for (var e : params.entrySet()) {
                    if (nonEmpty.contains(e.getKey()) && java.util.Arrays.stream(e.getValue()).anyMatch(String::isEmpty)) {
                        return Optional.of(e.getKey());
                    }
                }
                return Optional.empty();
            }
        }
        return Optional.empty();
    }

    /** The {@code Allow} value when {@code method} is not allowed on a contract path; empty otherwise. */
    public Optional<String> disallowed(String method, String path) {
        for (Route r : routes) {
            if (r.pattern.matcher(path).matches()) {
                return r.methods.contains(method) ? Optional.empty() : Optional.of(r.allow);
            }
        }
        return Optional.empty();
    }

    private record Route(Pattern pattern, Set<String> methods, String allow, Map<String, Set<String>> nonEmpty) {}
}
