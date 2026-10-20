package dev.krtmtthw.typhoon.shared.problem;

import java.io.IOException;
import java.util.Arrays;

import jakarta.servlet.RequestDispatcher;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.boot.webmvc.error.ErrorController;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.RequestMapping;

import dev.krtmtthw.typhoon.shared.web.RequestContext;

/**
 * Replaces Spring Boot's whitelabel {@code /error} page: anything the servlet container routes to the error
 * dispatch (an exception thrown outside MVC, a {@code sendError}) still becomes problem+json.
 */
@Controller
public class ProblemErrorController implements ErrorController {

    private final ProblemWriter writer;

    public ProblemErrorController(ProblemWriter writer) {
        this.writer = writer;
    }

    @RequestMapping("/error")
    public void error(HttpServletRequest request, HttpServletResponse response) throws IOException {
        Object code = request.getAttribute(RequestDispatcher.ERROR_STATUS_CODE);
        int status = code instanceof Integer i ? i : 500;
        ProblemType type = Arrays.stream(ProblemType.values())
                .filter(t -> t.status() == status)
                .findFirst()
                .orElse(status >= 500 ? ProblemType.INTERNAL : ProblemType.VALIDATION);
        // Report the original request, not /error.
        Object uri = request.getAttribute(RequestDispatcher.ERROR_REQUEST_URI);
        writer.write(new OriginalRequest(request, uri == null ? null : uri.toString()), response, type,
                type == ProblemType.INTERNAL ? "Unexpected error; see requestId in the logs." : null);
    }

    private static final class OriginalRequest extends jakarta.servlet.http.HttpServletRequestWrapper {

        private final String uri;

        OriginalRequest(HttpServletRequest request, String uri) {
            super(request);
            this.uri = uri;
        }

        @Override
        public String getRequestURI() {
            return uri != null ? uri : super.getRequestURI();
        }

        @Override
        public String getQueryString() {
            Object q = getAttribute(RequestDispatcher.FORWARD_QUERY_STRING);
            return uri != null ? (q == null ? null : q.toString()) : super.getQueryString();
        }
    }

    static String path(HttpServletRequest request) {
        return RequestContext.path(request);
    }
}
