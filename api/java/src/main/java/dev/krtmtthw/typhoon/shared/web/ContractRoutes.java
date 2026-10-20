package dev.krtmtthw.typhoon.shared.web;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

import org.springframework.stereotype.Component;

import dev.krtmtthw.typhoon.shared.ContractDocument;

/**
 * The contract's paths and their methods, read from the bundle. Used to answer any method the contract does not list
 * for a path with 405 {@code method-not-allowed} and an {@code Allow} header (RFC 9110), including methods the
 * servlet container would otherwise handle itself ({@code TRACE}) or not recognise ({@code QUERY}).
 */
@Component
public class ContractRoutes {

    private static final Set<String> HTTP_METHODS = Set.of("get", "put", "post", "delete", "options", "head", "patch", "trace");

    private final List<Route> routes = new ArrayList<>();

    public ContractRoutes(ContractDocument contract) {
        contract.tree().path("paths").properties().forEach(e -> {
            Set<String> methods = new LinkedHashSet<>();
            e.getValue().propertyNames().forEach(m -> {
                if (HTTP_METHODS.contains(m)) {
                    methods.add(m.toUpperCase(Locale.ROOT));
                }
            });
            if (methods.contains("GET")) {
                methods.add("HEAD");
            }
            methods.add("OPTIONS");
            String regex = Pattern.quote(e.getKey()).replaceAll("\\{[^}/]+}", "\\\\E[^/]+\\\\Q");
            routes.add(new Route(Pattern.compile(regex), Set.copyOf(methods), String.join(", ", methods)));
        });
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

    private record Route(Pattern pattern, Set<String> methods, String allow) {}
}
