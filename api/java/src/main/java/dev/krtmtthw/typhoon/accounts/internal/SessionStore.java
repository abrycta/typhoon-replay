package dev.krtmtthw.typhoon.accounts.internal;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.OffsetDateTime;
import java.util.Base64;
import java.util.Optional;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import dev.krtmtthw.typhoon.shared.catalog.CatalogRows;

/**
 * The custom session store over the contract-owned {@code auth.session} table (CONTRACT-GUIDE §9), shared by all four
 * backends. Tokens are 32 CSPRNG bytes, base64url; only {@code sha256(token)} is stored. No framework session
 * serialisation (Spring Session is not on the classpath; Spring Security runs stateless).
 */
@Repository
public class SessionStore {

    public static final java.time.Duration TTL = java.time.Duration.ofDays(30);

    private static final SecureRandom RANDOM = new SecureRandom();

    private final JdbcClient jdbc;

    public SessionStore(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public record Created(String token, OffsetDateTime expiresAt) {}

    public record Session(UUID userId, byte[] tokenHash) {}

    public Created create(UUID userId, String userAgent) {
        byte[] raw = new byte[32];
        RANDOM.nextBytes(raw);
        String token = Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
        String ua = userAgent == null ? null : userAgent.substring(0, Math.min(512, userAgent.length()));
        OffsetDateTime expires = jdbc.sql("""
                INSERT INTO auth.session (token_hash, user_id, expires_at, created_by_impl, user_agent)
                VALUES (:hash, :user, now() + interval '30 days', 'java', :ua)
                RETURNING expires_at""")
                .param("hash", hash(token)).param("user", userId).param("ua", ua)
                .query((rs, n) -> CatalogRows.timestamp(rs, "expires_at")).single();
        return new Created(token, expires);
    }

    /**
     * Looks a token up ({@code revoked_at IS NULL AND expires_at > now()}). Touches {@code last_seen_at} and slides
     * {@code expires_at} to now + 30 days, at most every 5 minutes.
     */
    public Optional<Session> find(String token) {
        if (token == null || token.isEmpty() || token.length() > 256) {
            return Optional.empty();
        }
        byte[] hash = hash(token);
        Optional<Row> row = jdbc.sql("""
                SELECT user_id, last_seen_at < now() - interval '5 minutes' AS stale
                FROM auth.session WHERE token_hash = :hash AND revoked_at IS NULL AND expires_at > now()""")
                .param("hash", hash)
                .query((rs, n) -> new Row(rs.getObject("user_id", UUID.class), rs.getBoolean("stale"))).optional();
        row.filter(Row::stale).ifPresent(r -> jdbc.sql("""
                UPDATE auth.session SET last_seen_at = now(), expires_at = now() + interval '30 days'
                WHERE token_hash = :hash AND revoked_at IS NULL""").param("hash", hash).update());
        return row.map(r -> new Session(r.userId(), hash));
    }

    public void revoke(String token) {
        if (token != null && !token.isEmpty() && token.length() <= 256) {
            jdbc.sql("UPDATE auth.session SET revoked_at = now() WHERE token_hash = :hash AND revoked_at IS NULL")
                    .param("hash", hash(token)).update();
        }
    }

    /** sha256 over the cookie value's UTF-8 bytes (the seed hashes {@code convert_to(token, 'UTF8')} the same way). */
    static byte[] hash(String token) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private record Row(UUID userId, boolean stale) {}
}
