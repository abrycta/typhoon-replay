package dev.krtmtthw.typhoon;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.ResultMatcher;

import com.networknt.schema.Schema;
import com.networknt.schema.SchemaLocation;
import com.networknt.schema.SchemaRegistry;
import com.networknt.schema.SchemaRegistryConfig;
import com.networknt.schema.SpecificationVersion;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Validates a MockMvc exchange against {@code contracts/dist/openapi.json}, the way the conformance suite does
 * (operation exists, status documented, required headers present, media type allowed, body matches the JSON Schema):
 * the Java equivalent of swagger-request-validator, on the same networknt 3 / Jackson 3 stack as the application.
 */
final class ContractMatcher {

    private static final String BASE = "https://typhoon-replay.pages.dev/contract/openapi.json";
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final JsonNode SPEC;
    private static final SchemaRegistry REGISTRY;

    static {
        try {
            String text = Files.readString(Path.of(System.getProperty("tr.contract", "../../contracts/dist/openapi.json")));
            SPEC = JSON.readTree(text);
            REGISTRY = SchemaRegistry.withDefaultDialect(SpecificationVersion.DRAFT_2020_12, b -> b
                    .schemaRegistryConfig(SchemaRegistryConfig.builder().formatAssertionsEnabled(true).build())
                    .schemas(Map.of(BASE, text)));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private ContractMatcher() {}

    static ResultMatcher conforms() {
        return result -> {
            List<String> errors = errors(result.getRequest(), result.getResponse());
            if (!errors.isEmpty()) {
                throw new AssertionError("Response does not match the contract: " + errors);
            }
        };
    }

    static List<String> errors(MockHttpServletRequest req, MockHttpServletResponse res) throws IOException {
        String template = template(req.getRequestURI());
        if (template == null) {
            return List.of("no contract path for " + req.getRequestURI());
        }
        String method = req.getMethod().toLowerCase(Locale.ROOT);
        String opPointer = "/paths/" + esc(template) + "/" + method;
        JsonNode op = SPEC.at(opPointer);
        if (op.isMissingNode()) {
            return List.of("operation " + method + " " + template + " not in contract");
        }
        String status = Integer.toString(res.getStatus());
        JsonNode response = op.path("responses").path(status);
        if (response.isMissingNode()) {
            return List.of("status " + status + " not documented for " + method + " " + template);
        }
        String pointer = opPointer + "/responses/" + status;
        if (response.has("$ref")) {
            pointer = response.get("$ref").asString().substring(1);
            response = SPEC.at(pointer);
        }
        List<String> errors = new ArrayList<>();
        for (var h : response.path("headers").properties()) {
            JsonNode header = h.getValue().has("$ref") ? SPEC.at(h.getValue().get("$ref").asString().substring(1)) : h.getValue();
            if (header.path("required").asBoolean(false) && res.getHeader(h.getKey()) == null) {
                errors.add("missing required header " + h.getKey());
            }
        }
        JsonNode content = response.path("content");
        if (content.isMissingNode() || content.isEmpty()) {
            return errors;
        }
        String type = res.getContentType() == null ? "" : res.getContentType().split(";")[0].trim();
        if (!content.has(type)) {
            errors.add("content-type " + type + " not in " + content.propertyNames());
            return errors;
        }
        if (type.matches("application/(json|problem\\+json|geo\\+json)")) {
            Schema schema = REGISTRY.getSchema(SchemaLocation.of(BASE + "#" + pointer + "/content/" + esc(type) + "/schema"));
            JsonNode body = JSON.readTree(res.getContentAsString(StandardCharsets.UTF_8));
            schema.validate(body).forEach(e -> errors.add("body" + e.getInstanceLocation() + " " + e.getMessage()));
        }
        return errors;
    }

    private static String template(String path) {
        String best = null;
        for (String t : SPEC.path("paths").propertyNames()) {
            String regex = Pattern.quote(t).replaceAll("\\{[^}/]+}", "\\\\E[^/]+\\\\Q");
            if (path.matches(regex) && (best == null || !t.contains("{"))) {
                best = t;
            }
        }
        return best;
    }

    private static String esc(String s) {
        return s.replace("~", "~0").replace("/", "~1");
    }
}
