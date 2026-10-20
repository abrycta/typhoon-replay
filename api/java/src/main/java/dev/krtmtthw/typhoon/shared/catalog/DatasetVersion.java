package dev.krtmtthw.typhoon.shared.catalog;

import java.util.Collection;

import jakarta.servlet.http.HttpServletRequest;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import dev.krtmtthw.typhoon.shared.web.Etags;

/**
 * The newest {@code catalog.dataset_version}: part of every catalogue ETag and of {@code /v1/meta}. Read at most every
 * few seconds, so a pipeline publish invalidates ETags almost at once without a query per request.
 */
@Component
public class DatasetVersion {

    private static final long TTL_NANOS = 5_000_000_000L;

    private final JdbcClient jdbc;
    private volatile long cached = -1;
    private volatile long readAt;

    public DatasetVersion(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public long current() {
        long now = System.nanoTime();
        if (cached < 0 || now - readAt > TTL_NANOS) {
            cached = jdbc.sql("SELECT coalesce((SELECT version FROM catalog.current_dataset_version), 0)")
                    .query(Long.class).single();
            readAt = now;
        }
        return cached;
    }

    /** The catalogue ETag of this request (CONTRACT-GUIDE §6). */
    public String etag(HttpServletRequest request, Collection<String> recognisedParams) {
        return Etags.catalogue(current(), request, recognisedParams);
    }
}
