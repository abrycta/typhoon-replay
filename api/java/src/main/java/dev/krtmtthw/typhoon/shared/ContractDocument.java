package dev.krtmtthw.typhoon.shared;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;

import org.springframework.boot.info.BuildProperties;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * The contract bundle ({@code contracts/dist/openapi.json}) copied onto the classpath at build time. Served unchanged
 * by {@code GET /v1/openapi.json}; its {@code info.version} is the contract version this build implements, and its
 * component schemas validate request bodies.
 */
@Component
public class ContractDocument {

    private final byte[] bytes;
    private final JsonNode tree;
    private final String contractVersion;
    private final String implVersion;

    public ContractDocument(JsonMapper json, java.util.Optional<BuildProperties> build) {
        try (InputStream in = new ClassPathResource("contract/openapi.json").getInputStream()) {
            this.bytes = in.readAllBytes();
        } catch (IOException e) {
            throw new UncheckedIOException("contract/openapi.json missing from the classpath: run `just bundle`", e);
        }
        this.tree = json.readTree(bytes);
        this.contractVersion = tree.path("info").path("version").asString();
        this.implVersion = build.map(BuildProperties::getVersion).orElse("0.0.0");
    }

    public byte[] bytes() {
        return bytes.clone();
    }

    public JsonNode tree() {
        return tree;
    }

    public String contractVersion() {
        return contractVersion;
    }

    /** Semver of this backend build ({@code X-Backend-Version}, {@code implVersion}). */
    public String implVersion() {
        return implVersion;
    }
}
