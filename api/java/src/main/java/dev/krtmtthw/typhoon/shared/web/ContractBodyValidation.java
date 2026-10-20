package dev.krtmtthw.typhoon.shared.web;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.Type;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import org.springframework.core.MethodParameter;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpInputMessage;
import org.springframework.http.converter.HttpMessageConverter;
import org.springframework.web.bind.annotation.ControllerAdvice;
import org.springframework.web.servlet.mvc.method.annotation.RequestBodyAdviceAdapter;

import com.networknt.schema.Error;
import com.networknt.schema.Schema;
import com.networknt.schema.SchemaLocation;
import com.networknt.schema.SchemaRegistry;
import com.networknt.schema.SchemaRegistryConfig;
import com.networknt.schema.SpecificationVersion;

import dev.krtmtthw.typhoon.shared.ContractDocument;
import dev.krtmtthw.typhoon.shared.problem.ApiException;
import dev.krtmtthw.typhoon.shared.problem.ProblemType;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Validates every JSON request body against the contract's own JSON Schema (the component the generated model was
 * made from) before Jackson binds it. Bean Validation on the generated models cannot see the difference between an
 * absent field and an explicit {@code null}, nor duplicates in a {@code uniqueItems} array that binds to a
 * {@code Set}; the schema can, so the contract stays the single source of truth for what a valid body is.
 * Failures are 400 {@code validation} with {@code errors[].pointer} under {@code #/body}.
 */
@ControllerAdvice
public class ContractBodyValidation extends RequestBodyAdviceAdapter {

    private static final String BASE = "https://typhoon-replay.pages.dev/contract/openapi.json";

    private final JsonMapper json;
    private final SchemaRegistry registry;
    private final JsonNode schemas;
    private final Map<Class<?>, Schema> cache = new ConcurrentHashMap<>();

    public ContractBodyValidation(ContractDocument contract, JsonMapper json) {
        this.json = json;
        this.schemas = contract.tree().path("components").path("schemas");
        String text = new String(contract.bytes(), StandardCharsets.UTF_8);
        SchemaRegistryConfig config = SchemaRegistryConfig.builder().formatAssertionsEnabled(true).build();
        this.registry = SchemaRegistry.withDefaultDialect(SpecificationVersion.DRAFT_2020_12,
                builder -> builder.schemaRegistryConfig(config).schemas(Map.of(BASE, text)));
    }

    @Override
    public boolean supports(MethodParameter parameter, Type targetType, Class<? extends HttpMessageConverter<?>> converterType) {
        return targetType instanceof Class<?> c && schemas.has(c.getSimpleName());
    }

    @Override
    public HttpInputMessage beforeBodyRead(HttpInputMessage input, MethodParameter parameter, Type targetType,
            Class<? extends HttpMessageConverter<?>> converterType) throws IOException {
        byte[] body;
        try (InputStream in = input.getBody()) {
            body = in.readAllBytes();
        }
        JsonNode node;
        try {
            node = json.readTree(body);
        } catch (JacksonException e) {
            throw ApiException.validation("#/body", "is not valid JSON");
        }
        if (node == null || node.isMissingNode()) {
            throw ApiException.validation("#/body", "is required");
        }
        Schema schema = cache.computeIfAbsent((Class<?>) targetType, c -> registry.getSchema(
                SchemaLocation.of(BASE + "#/components/schemas/" + c.getSimpleName())));
        List<Error> problems = schema.validate(node);
        if (!problems.isEmpty()) {
            List<ApiException.FieldProblem> errors = new ArrayList<>();
            for (Error e : problems) {
                errors.add(new ApiException.FieldProblem(pointer(e), e.getMessage()));
            }
            throw new ApiException(ProblemType.VALIDATION, "The request body does not match the contract.", errors);
        }
        HttpHeaders headers = input.getHeaders();
        return new HttpInputMessage() {
            @Override
            public InputStream getBody() {
                return new ByteArrayInputStream(body);
            }

            @Override
            public HttpHeaders getHeaders() {
                return headers;
            }
        };
    }

    private static String pointer(Error e) {
        StringBuilder sb = new StringBuilder("#/body");
        var path = e.getInstanceLocation();
        for (int i = 0; i < path.getNameCount(); i++) {
            sb.append('/').append(path.getElement(i));
        }
        if ("required".equals(e.getKeyword()) && e.getProperty() != null) {
            sb.append('/').append(e.getProperty());
        }
        return sb.toString();
    }
}
