package dev.krtmtthw.typhoon;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.context.annotation.Bean;
import org.testcontainers.containers.Container;
import org.testcontainers.images.builder.Transferable;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;
import org.testcontainers.utility.MountableFile;

/**
 * PostGIS matching production (Neon: PostgreSQL 18.6, PostGIS 3.6.4) loaded with the contract's dbmate migrations
 * and the conformance seed, as {@code just db-up} does. Tests apply the contract's DDL; the backend never does.
 * Testcontainers picks a random host port, so it never collides with a local compose database.
 */
@TestConfiguration(proxyBeanMethods = false)
public class ContractDatabase {

    private static final DockerImageName IMAGE = DockerImageName
            .parse(System.getProperty("tr.postgis.image", "postgis/postgis:18-3.6"))
            .asCompatibleSubstituteFor("postgres");

    private static final PostgreSQLContainer DB = start();

    @Bean
    @ServiceConnection
    PostgreSQLContainer postgis() {
        return DB;
    }

    /** Reloads the deterministic fixture (wipes catalogue and live data). */
    public static void reseed() {
        psql(DB, "-q", "-1", "-f", "/db/seed/seed.sql");
    }

    private static PostgreSQLContainer start() {
        Path contracts = Path.of(System.getProperty("tr.migrations", "../../contracts/db")).toAbsolutePath().normalize();
        PostgreSQLContainer db = new PostgreSQLContainer(IMAGE)
                .withDatabaseName("typhoon").withUsername("tr").withPassword("tr")
                // Like Neon, the database starts without extensions: the first migration creates them.
                .withTmpFs(Map.of("/docker-entrypoint-initdb.d", "rw"))
                .withCopyFileToContainer(MountableFile.forHostPath(contracts), "/db")
                // Reused across runs when ~/.testcontainers.properties has testcontainers.reuse.enable=true.
                .withReuse(true);
        db.start();
        try {
            // A reused container may predate newer migrations: apply only the ones it has not seen (like dbmate up).
            psql(db, "-q", "-c", "CREATE TABLE IF NOT EXISTS public.schema_migrations (version varchar(128) PRIMARY KEY)");
            java.util.Set<String> applied = applied(db);
            List<Path> files;
            try (Stream<Path> s = Files.list(contracts.resolve("migrations"))) {
                files = s.filter(p -> p.toString().endsWith(".sql")).sorted().toList();
            }
            for (Path f : files) {
                String version = f.getFileName().toString().split("_")[0];
                if (applied.contains(version)) {
                    continue;
                }
                String sql = Files.readString(f);
                String up = sql.substring(sql.indexOf("-- migrate:up"), sql.indexOf("-- migrate:down"));
                String target = "/tmp/" + f.getFileName();
                db.copyFileToContainer(Transferable.of(up + "\nINSERT INTO public.schema_migrations VALUES ('" + version + "');\n"),
                        target);
                psql(db, "-q", "-1", "-f", target);
            }
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
        psql(db, "-q", "-1", "-f", "/db/seed/seed.sql");
        return db;
    }

    private static java.util.Set<String> applied(PostgreSQLContainer db) {
        try {
            return java.util.Set.copyOf(db.execInContainer("psql", "-U", "tr", "-d", "typhoon", "-Atc",
                    "SELECT version FROM public.schema_migrations").getStdout().lines().map(String::trim)
                    .filter(v -> !v.isEmpty()).toList());
        } catch (IOException | InterruptedException e) {
            throw new IllegalStateException(e);
        }
    }

    private static void psql(PostgreSQLContainer db, String... args) {
        String[] cmd = Stream.concat(Stream.of("psql", "-U", "tr", "-d", "typhoon", "-v", "ON_ERROR_STOP=1"), Stream.of(args))
                .toArray(String[]::new);
        try {
            Container.ExecResult r = db.execInContainer(cmd);
            if (r.getExitCode() != 0) {
                throw new IllegalStateException("psql " + String.join(" ", args) + " failed: " + r.getStderr());
            }
        } catch (IOException | InterruptedException e) {
            throw new IllegalStateException(e);
        }
    }
}
