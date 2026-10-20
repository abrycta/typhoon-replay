package dev.krtmtthw.typhoon.meta;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Map;
import java.util.Optional;

import org.springframework.boot.availability.ApplicationAvailability;
import org.springframework.boot.availability.ReadinessState;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RestController;

import dev.krtmtthw.typhoon.contract.api.MetaApi;
import dev.krtmtthw.typhoon.contract.model.Health;
import dev.krtmtthw.typhoon.contract.model.Impl;
import dev.krtmtthw.typhoon.contract.model.Meta;
import dev.krtmtthw.typhoon.contract.model.OpenApiDocument;
import dev.krtmtthw.typhoon.contract.model.Readiness;
import dev.krtmtthw.typhoon.shared.ContractDocument;
import dev.krtmtthw.typhoon.shared.TrProperties;
import dev.krtmtthw.typhoon.shared.catalog.DatasetVersion;
import dev.krtmtthw.typhoon.shared.problem.ApiException;
import dev.krtmtthw.typhoon.shared.problem.ProblemType;
import dev.krtmtthw.typhoon.shared.web.Etags;

/** Probes, metadata and the contract bundle (tag {@code meta}). */
@RestController
class MetaController implements MetaApi {

    private final TrProperties props;
    private final ContractDocument contract;
    private final SchemaVersion schema;
    private final DatasetVersion dataset;
    private final ApplicationAvailability availability;
    private final OffsetDateTime startedAt = OffsetDateTime.now(ZoneOffset.UTC);
    private final String metaEtag;

    MetaController(TrProperties props, ContractDocument contract, SchemaVersion schema, DatasetVersion dataset,
            ApplicationAvailability availability) {
        this.props = props;
        this.contract = contract;
        this.schema = schema;
        this.dataset = dataset;
        this.availability = availability;
        this.metaEtag = "W/\"c" + contract.contractVersion() + "-" + props.impl() + "-" + contract.implVersion() + "\"";
    }

    /** Liveness: the process answers; no database access. */
    @Override
    public ResponseEntity<Health> getHealth() {
        return ResponseEntity.ok(new Health(Health.StatusEnum.OK, impl()));
    }

    /** Readiness: accepting traffic, database reachable and schema at least {@code minSchemaVersion}. */
    @Override
    public ResponseEntity<Readiness> getReadiness() {
        Optional<String> applied = schema.applied();
        boolean accepting = availability.getReadinessState() == ReadinessState.ACCEPTING_TRAFFIC;
        if (!accepting || applied.filter(schema::isCompatible).isEmpty()) {
            throw new ApiException(ProblemType.NOT_READY,
                    applied.isEmpty() ? "Database unreachable or not migrated." : "Database schema is older than " + schema.minimum() + ".",
                    java.util.List.of(), Map.of("Retry-After", "5"));
        }
        return ResponseEntity.ok(new Readiness(Readiness.StatusEnum.READY, impl(), applied.get(), schema.minimum()));
    }

    @Override
    public ResponseEntity<Meta> getMeta(String ifNoneMatch) {
        if (Etags.matches(ifNoneMatch, metaEtag)) {
            return Etags.notModified(metaEtag);
        }
        Meta meta = new Meta(impl(), contract.implVersion(), contract.contractVersion(),
                schema.applied().orElse("00000000000000"), (int) dataset.current(), props.commit(), startedAt);
        return ResponseEntity.ok().eTag(metaEtag).body(meta);
    }

    /** The bundle byte for byte (the body is the raw file, not a re-serialised model). */
    @Override
    @SuppressWarnings({"unchecked", "rawtypes"})
    public ResponseEntity<OpenApiDocument> getOpenApiDocument(String ifNoneMatch) {
        if (Etags.matches(ifNoneMatch, metaEtag)) {
            return Etags.notModified(metaEtag);
        }
        return (ResponseEntity) ResponseEntity.ok().eTag(metaEtag).contentType(MediaType.APPLICATION_JSON).body(contract.bytes());
    }

    private Impl impl() {
        return Impl.fromValue(props.impl());
    }
}
