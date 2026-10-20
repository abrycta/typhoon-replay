package dev.krtmtthw.typhoon.shared.web;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import dev.krtmtthw.typhoon.shared.problem.ProblemType;
import dev.krtmtthw.typhoon.shared.problem.ProblemWriter;

/**
 * Request bodies over 64 KB get 413 {@code payload-too-large} (CONTRACT-GUIDE §11), before parsing (only the test
 * hooks take a body). A declared {@code Content-Length} is checked directly; a chunked body is buffered up to the
 * limit.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 20)
public class BodyLimitFilter extends OncePerRequestFilter {

    public static final int MAX_BODY_BYTES = 64 * 1024;

    private final ProblemWriter problems;

    public BodyLimitFilter(ProblemWriter problems) {
        this.problems = problems;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String method = request.getMethod();
        return method.equals("GET") || method.equals("HEAD") || method.equals("OPTIONS");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        long declared = request.getContentLengthLong();
        if (declared > MAX_BODY_BYTES) {
            tooLarge(request, response);
            return;
        }
        if (declared >= 0) {
            chain.doFilter(request, response);
            return;
        }
        byte[] body = request.getInputStream().readNBytes(MAX_BODY_BYTES + 1);
        if (body.length > MAX_BODY_BYTES) {
            tooLarge(request, response);
            return;
        }
        chain.doFilter(new BufferedBodyRequest(request, body), response);
    }

    private void tooLarge(HttpServletRequest request, HttpServletResponse response) throws IOException {
        problems.write(request, response, ProblemType.PAYLOAD_TOO_LARGE, "Request bodies are limited to 64 KB.");
        response.setHeader("Connection", "close");
    }

    private static final class BufferedBodyRequest extends HttpServletRequestWrapper {

        private final byte[] body;

        BufferedBodyRequest(HttpServletRequest request, byte[] body) {
            super(request);
            this.body = body;
        }

        @Override
        public int getContentLength() {
            return body.length;
        }

        @Override
        public long getContentLengthLong() {
            return body.length;
        }

        @Override
        public ServletInputStream getInputStream() {
            InputStream in = new ByteArrayInputStream(body);
            return new ServletInputStream() {
                @Override
                public int read() throws IOException {
                    return in.read();
                }

                @Override
                public int read(byte[] b, int off, int len) throws IOException {
                    return in.read(b, off, len);
                }

                @Override
                public boolean isFinished() {
                    try {
                        return in.available() == 0;
                    } catch (IOException e) {
                        return true;
                    }
                }

                @Override
                public boolean isReady() {
                    return true;
                }

                @Override
                public void setReadListener(ReadListener listener) {
                    throw new UnsupportedOperationException();
                }
            };
        }
    }
}
