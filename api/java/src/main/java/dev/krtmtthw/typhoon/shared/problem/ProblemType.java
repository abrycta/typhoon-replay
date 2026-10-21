package dev.krtmtthw.typhoon.shared.problem;

/** The contract's stable problem codes with their fixed status and title (ProblemCode, CONTRACT-GUIDE §8). */
public enum ProblemType {
    VALIDATION(400, "validation", "Request validation failed"),
    INVALID_CURSOR(400, "invalid-cursor", "Invalid cursor"),
    NOT_FOUND(404, "not-found", "Not found"),
    METHOD_NOT_ALLOWED(405, "method-not-allowed", "Method not allowed"),
    NOT_ACCEPTABLE(406, "not-acceptable", "Not acceptable"),
    PAYLOAD_TOO_LARGE(413, "payload-too-large", "Payload too large"),
    UNSUPPORTED_MEDIA_TYPE(415, "unsupported-media-type", "Unsupported media type"),
    RATE_LIMITED(429, "rate-limited", "Too many requests"),
    INTERNAL(500, "internal", "Internal server error"),
    NOT_READY(503, "not-ready", "Service not ready"),
    STREAM_CAPACITY(503, "stream-capacity", "Too many live streams");

    public static final String TYPE_BASE = "https://replay.krtmtthw.dev/problems/";

    private final int status;
    private final String code;
    private final String title;

    ProblemType(int status, String code, String title) {
        this.status = status;
        this.code = code;
        this.title = title;
    }

    public int status() {
        return status;
    }

    public String code() {
        return code;
    }

    public String title() {
        return title;
    }

    public String typeUri() {
        return TYPE_BASE + code;
    }
}
