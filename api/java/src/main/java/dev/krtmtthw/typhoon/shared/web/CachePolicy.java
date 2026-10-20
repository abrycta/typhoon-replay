package dev.krtmtthw.typhoon.shared.web;

/**
 * The Cache-Control table of CONTRACT-GUIDE §6, by resource class. The request filter applies the success value up
 * front; {@code ProblemWriter} replaces it on errors.
 */
public final class CachePolicy {

    public static final String CATALOGUE = "public, max-age=300, stale-while-revalidate=86400";
    public static final String META = "public, max-age=60";
    public static final String LIVE = "no-cache";
    public static final String PRIVATE = "private, no-store";
    public static final String NO_STORE = "no-store";
    public static final String CATALOGUE_NOT_FOUND = "public, max-age=60";

    private CachePolicy() {}

    /** Cache-Control of a successful (2xx/3xx) response to {@code path}. */
    public static String forSuccess(String path) {
        if (path.equals("/healthz") || path.equals("/readyz")) {
            return NO_STORE;
        }
        if (path.equals("/v1/meta") || path.equals("/v1/openapi.json")) {
            return META;
        }
        if (path.startsWith("/v1/live/")) {
            return LIVE;
        }
        if (isSessionScoped(path) || path.startsWith("/v1/alerts/") || path.startsWith("/v1/_test/")) {
            return PRIVATE;
        }
        if (isCatalogue(path)) {
            return CATALOGUE;
        }
        return NO_STORE;
    }

    /** Cache-Control of an error: {@code no-store}, except a 404 on a catalogue read. */
    public static String forError(int status, String method, String path) {
        return status == 404 && "GET".equals(method) && isCatalogue(path) ? CATALOGUE_NOT_FOUND : NO_STORE;
    }

    /** Catalogue reads: storms, places, hits and place search. */
    public static boolean isCatalogue(String path) {
        return path.equals("/v1/storms") || path.startsWith("/v1/storms/")
                || path.startsWith("/v1/places/") || path.equals("/v1/hits");
    }

    /** Responses that depend on the session cookie, so they also carry {@code Vary: Cookie}. */
    public static boolean isSessionScoped(String path) {
        return path.equals("/v1/me") || path.startsWith("/v1/me/") || path.startsWith("/v1/auth/");
    }
}
