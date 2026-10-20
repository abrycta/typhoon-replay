package dev.krtmtthw.typhoon.meta;

import java.util.Optional;

import org.springframework.boot.health.contributor.Health;
import org.springframework.boot.health.contributor.HealthIndicator;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import dev.krtmtthw.typhoon.shared.TrProperties;

/**
 * The newest dbmate migration applied to the database ({@code public.schema_migrations}). Backends never run DDL
 * (CONTRACT-GUIDE §0): they only refuse traffic until the schema is at least {@code minSchemaVersion}. Also the
 * {@code contractSchema} indicator of the Actuator readiness group, which {@code /readyz} mirrors.
 */
@Component("contractSchema")
class SchemaVersion implements HealthIndicator {

    private final JdbcClient jdbc;
    private final String minimum;

    SchemaVersion(JdbcClient jdbc, TrProperties props) {
        this.jdbc = jdbc;
        this.minimum = props.minSchemaVersion();
    }

    /** The applied schema version; empty if the database is unreachable or not migrated. */
    Optional<String> applied() {
        try {
            return jdbc.sql("SELECT max(version) FROM public.schema_migrations").query(String.class).optional();
        } catch (RuntimeException e) {
            return Optional.empty();
        }
    }

    String minimum() {
        return minimum;
    }

    boolean isCompatible(String applied) {
        return applied != null && applied.compareTo(minimum) >= 0;
    }

    @Override
    public Health health() {
        Optional<String> applied = applied();
        Health.Builder builder = applied.filter(this::isCompatible).isPresent() ? Health.up() : Health.down();
        return builder.withDetail("schemaVersion", applied.orElse("unknown")).withDetail("minSchemaVersion", minimum).build();
    }
}
