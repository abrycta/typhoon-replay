package dev.krtmtthw.typhoon.shared;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Runtime configuration. Every value comes from the environment with the names shared by all four backends
 * (CONTRACT-GUIDE §11); {@code application.yaml} maps {@code TR_*} variables onto these properties.
 *
 * @param impl              backend id sent in {@code X-Backend-Impl} ({@code java})
 * @param siteOrigin        browser-visible origin of absolute {@code Link} headers
 * @param testHooks         {@code TR_TEST_HOOKS=1} enables {@code /v1/_test/*}
 * @param minSchemaVersion  the oldest dbmate migration this build can run against ({@code /readyz})
 * @param commit            git commit of the build ({@code /v1/meta})
 * @param rateLimitPerMinute per-IP request budget; 0 disables the limiter
 * @param maxStreams        concurrent SSE streams before 503 {@code stream-capacity} (contract minimum 50)
 * @param edgeSecret        shared with the edge proxy ({@code X-Edge-Secret}); only requests carrying it have their
 *                          {@code X-Forwarded-For} trusted by the rate limiter. Blank: no request is trusted
 */
@ConfigurationProperties(prefix = "tr")
public record TrProperties(
        String impl,
        String siteOrigin,
        boolean testHooks,
        String minSchemaVersion,
        String commit,
        int rateLimitPerMinute,
        int maxStreams,
        String edgeSecret) {

    public TrProperties {
        if (siteOrigin != null && siteOrigin.endsWith("/")) {
            siteOrigin = siteOrigin.substring(0, siteOrigin.length() - 1);
        }
    }
}
