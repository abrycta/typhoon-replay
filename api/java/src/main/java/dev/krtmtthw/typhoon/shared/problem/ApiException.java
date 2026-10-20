package dev.krtmtthw.typhoon.shared.problem;

import java.util.List;
import java.util.Map;

/**
 * Any failure that should reach the client as a problem document. Thrown from controllers, services and filters;
 * rendered by {@link ProblemWriter}.
 */
public class ApiException extends RuntimeException {

    private final ProblemType type;
    private final transient List<FieldProblem> errors;
    private final transient Map<String, String> headers;

    public ApiException(ProblemType type, String detail) {
        this(type, detail, List.of(), Map.of());
    }

    public ApiException(ProblemType type, String detail, List<FieldProblem> errors) {
        this(type, detail, errors, Map.of());
    }

    public ApiException(ProblemType type, String detail, List<FieldProblem> errors, Map<String, String> headers) {
        super(detail, null, false, false);
        this.type = type;
        this.errors = List.copyOf(errors);
        this.headers = Map.copyOf(headers);
    }

    public static ApiException notFound(String detail) {
        return new ApiException(ProblemType.NOT_FOUND, detail);
    }

    public static ApiException validation(String pointer, String detail) {
        return new ApiException(ProblemType.VALIDATION, detail, List.of(new FieldProblem(pointer, detail)));
    }

    public static ApiException invalidCursor(String detail) {
        return new ApiException(ProblemType.INVALID_CURSOR, detail, List.of(new FieldProblem("#/query/cursor", detail)));
    }

    public static ApiException unprocessable(String detail) {
        return new ApiException(ProblemType.UNPROCESSABLE, detail);
    }

    public ProblemType type() {
        return type;
    }

    public List<FieldProblem> errors() {
        return errors;
    }

    public Map<String, String> headers() {
        return headers;
    }

    /** One entry of the problem's {@code errors} array: where the bad input was, and why. */
    public record FieldProblem(String pointer, String detail) {}
}
