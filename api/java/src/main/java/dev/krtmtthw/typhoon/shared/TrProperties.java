package dev.krtmtthw.typhoon.shared;

import java.util.Map;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Runtime configuration. Every value comes from the environment with the names shared by all four backends
 * (CONTRACT-GUIDE §11); {@code application.yaml} maps {@code TR_*} variables onto these properties.
 *
 * @param impl              backend id sent in {@code X-Backend-Impl} ({@code java})
 * @param siteOrigin        browser-visible origin: CSRF {@code Origin} check, OAuth redirect URIs, {@code Link} headers
 * @param allowedOrigins    further origins the CSRF check accepts (previews); the site origin is always accepted
 * @param testHooks         {@code TR_TEST_HOOKS=1} enables {@code /v1/_test/*}
 * @param minSchemaVersion  the oldest dbmate migration this build can run against ({@code /readyz})
 * @param commit            git commit of the build ({@code /v1/meta})
 * @param rateLimitPerMinute per-IP request budget; 0 disables the limiter
 * @param maxStreams        concurrent SSE streams before 503 {@code stream-capacity} (contract minimum 50)
 * @param oauth             provider endpoints and credentials, keyed by provider id
 */
@ConfigurationProperties(prefix = "tr")
public record TrProperties(
        String impl,
        String siteOrigin,
        java.util.List<String> allowedOrigins,
        boolean testHooks,
        String minSchemaVersion,
        String commit,
        int rateLimitPerMinute,
        int maxStreams,
        Map<String, OAuthProvider> oauth) {

    public TrProperties {
        if (siteOrigin != null && siteOrigin.endsWith("/")) {
            siteOrigin = siteOrigin.substring(0, siteOrigin.length() - 1);
        }
        oauth = oauth == null ? Map.of() : Map.copyOf(oauth);
        allowedOrigins = allowedOrigins == null ? java.util.List.of()
                : allowedOrigins.stream().map(String::trim).filter(o -> !o.isEmpty())
                        .map(o -> o.endsWith("/") ? o.substring(0, o.length() - 1) : o).toList();
    }

    /** Every origin the CSRF check accepts: the site origin plus {@link #allowedOrigins()}. */
    public java.util.Set<String> csrfOrigins() {
        java.util.Set<String> all = new java.util.LinkedHashSet<>(allowedOrigins);
        all.add(siteOrigin);
        return all;
    }

    public record OAuthProvider(String clientId, String clientSecret, String authUrl, String tokenUrl, String userinfoUrl) {}
}
