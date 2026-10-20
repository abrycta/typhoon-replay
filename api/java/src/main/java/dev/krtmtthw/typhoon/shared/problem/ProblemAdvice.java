package dev.krtmtthw.typhoon.shared.problem;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.MethodParameter;
import org.springframework.http.HttpMethod;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.validation.FieldError;
import org.springframework.web.HttpMediaTypeNotAcceptableException;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingRequestHeaderException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.ServletRequestBindingException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.async.AsyncRequestNotUsableException;
import org.springframework.web.context.request.async.AsyncRequestTimeoutException;
import org.springframework.web.method.annotation.HandlerMethodValidationException;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.NoHandlerFoundException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

/**
 * Maps every exception that reaches Spring MVC onto the contract's problem codes (CONTRACT-GUIDE §8). Validation
 * failures carry {@code errors[].pointer} as {@code #/query/{name}}, {@code #/path/{name}}, {@code #/header/{name}} or
 * {@code #/body/...}.
 */
@RestControllerAdvice
public class ProblemAdvice {

    private static final Logger LOG = LoggerFactory.getLogger(ProblemAdvice.class);

    private final ProblemWriter writer;

    public ProblemAdvice(ProblemWriter writer) {
        this.writer = writer;
    }

    @ExceptionHandler(ApiException.class)
    public void api(ApiException e, HttpServletRequest req, HttpServletResponse res) throws IOException {
        writer.write(req, res, e);
    }

    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public void typeMismatch(MethodArgumentTypeMismatchException e, HttpServletRequest req, HttpServletResponse res)
            throws IOException {
        String pointer = pointer(e.getParameter(), e.getName());
        writer.write(req, res, ApiException.validation(pointer, "has an invalid value"));
    }

    @ExceptionHandler(MissingServletRequestParameterException.class)
    public void missingParam(MissingServletRequestParameterException e, HttpServletRequest req, HttpServletResponse res)
            throws IOException {
        writer.write(req, res, ApiException.validation("#/query/" + e.getParameterName(), "is required"));
    }

    @ExceptionHandler(MissingRequestHeaderException.class)
    public void missingHeader(MissingRequestHeaderException e, HttpServletRequest req, HttpServletResponse res)
            throws IOException {
        writer.write(req, res, ApiException.validation("#/header/" + e.getHeaderName(), "is required"));
    }

    @ExceptionHandler(ServletRequestBindingException.class)
    public void binding(ServletRequestBindingException e, HttpServletRequest req, HttpServletResponse res)
            throws IOException {
        writer.write(req, res, new ApiException(ProblemType.VALIDATION, "The request could not be bound."));
    }

    @ExceptionHandler(HandlerMethodValidationException.class)
    public void methodValidation(HandlerMethodValidationException e, HttpServletRequest req, HttpServletResponse res)
            throws IOException {
        List<ApiException.FieldProblem> errors = new ArrayList<>();
        e.getParameterValidationResults().forEach(result -> {
            String pointer = pointer(result.getMethodParameter(), result.getMethodParameter().getParameterName());
            result.getResolvableErrors().forEach(err -> errors.add(new ApiException.FieldProblem(pointer, err.getDefaultMessage())));
        });
        writer.write(req, res, new ApiException(ProblemType.VALIDATION, summary(errors), errors));
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public void bodyValidation(MethodArgumentNotValidException e, HttpServletRequest req, HttpServletResponse res)
            throws IOException {
        List<ApiException.FieldProblem> errors = e.getBindingResult().getFieldErrors().stream()
                .map((FieldError f) -> new ApiException.FieldProblem(
                        "#/body/" + f.getField().replace('.', '/').replaceAll("\\[(\\d+)]", "/$1"), f.getDefaultMessage()))
                .toList();
        writer.write(req, res, new ApiException(ProblemType.VALIDATION, summary(errors), errors));
    }

    @ExceptionHandler(org.springframework.security.web.firewall.RequestRejectedException.class)
    public void rejected(Exception e, HttpServletRequest req, HttpServletResponse res) throws IOException {
        writer.write(req, res, new ApiException(ProblemType.VALIDATION, "The request was rejected as malformed."));
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public void unreadable(HttpMessageNotReadableException e, HttpServletRequest req, HttpServletResponse res)
            throws IOException {
        writer.write(req, res, ApiException.validation("#/body", "is not valid JSON for this operation"));
    }

    @ExceptionHandler(HttpMediaTypeNotSupportedException.class)
    public void unsupportedMediaType(HttpMediaTypeNotSupportedException e, HttpServletRequest req, HttpServletResponse res)
            throws IOException {
        writer.write(req, res, new ApiException(ProblemType.UNSUPPORTED_MEDIA_TYPE, "Request bodies must be application/json."));
    }

    @ExceptionHandler(HttpMediaTypeNotAcceptableException.class)
    public void notAcceptable(HttpMediaTypeNotAcceptableException e, HttpServletRequest req, HttpServletResponse res)
            throws IOException {
        writer.write(req, res, new ApiException(ProblemType.NOT_ACCEPTABLE, "No acceptable representation."));
    }

    @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
    public void methodNotAllowed(HttpRequestMethodNotSupportedException e, HttpServletRequest req, HttpServletResponse res)
            throws IOException {
        Set<HttpMethod> allowed = e.getSupportedHttpMethods();
        String allow = allowed == null ? "" : allowed.stream().map(HttpMethod::name).collect(Collectors.joining(", "));
        writer.write(req, res, new ApiException(ProblemType.METHOD_NOT_ALLOWED,
                "Method " + e.getMethod() + " is not supported here.", List.of(), Map.of("Allow", allow)));
    }

    @ExceptionHandler({NoResourceFoundException.class, NoHandlerFoundException.class})
    public void noRoute(Exception e, HttpServletRequest req, HttpServletResponse res) throws IOException {
        writer.write(req, res, ApiException.notFound("No such resource."));
    }

    @ExceptionHandler({AsyncRequestTimeoutException.class, AsyncRequestNotUsableException.class})
    public void asyncDone(Exception e) {
        // An event stream ended (timeout or client gone): the response is already committed, nothing to write.
    }

    @ExceptionHandler(Exception.class)
    public void unexpected(Exception e, HttpServletRequest req, HttpServletResponse res) throws IOException {
        LOG.error("unhandled {} on {} {}", e.getClass().getName(), req.getMethod(), req.getRequestURI(), e);
        writer.write(req, res, new ApiException(ProblemType.INTERNAL, "Unexpected error; see requestId in the logs."));
    }

    private static String pointer(MethodParameter p, String fallbackName) {
        if (p != null) {
            PathVariable path = p.getParameterAnnotation(PathVariable.class);
            if (path != null) {
                return "#/path/" + firstNonEmpty(path.value(), path.name(), fallbackName);
            }
            RequestHeader header = p.getParameterAnnotation(RequestHeader.class);
            if (header != null) {
                return "#/header/" + firstNonEmpty(header.value(), header.name(), fallbackName);
            }
            RequestParam param = p.getParameterAnnotation(RequestParam.class);
            if (param != null) {
                return "#/query/" + firstNonEmpty(param.value(), param.name(), fallbackName);
            }
        }
        return "#/query/" + fallbackName;
    }

    private static String firstNonEmpty(String... values) {
        for (String v : values) {
            if (v != null && !v.isEmpty()) {
                return v;
            }
        }
        return "unknown";
    }

    private static String summary(List<ApiException.FieldProblem> errors) {
        return errors.isEmpty() ? "Invalid request." : errors.stream()
                .map(e -> e.pointer().substring(2) + " " + e.detail()).collect(Collectors.joining("; "));
    }
}
