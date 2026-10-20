package dev.krtmtthw.typhoon.shared.problem;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.jdbc.CannotGetJdbcConnectionException;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import tools.jackson.databind.json.JsonMapper;

/** A database that is still waking up is a temporary 503, never a 500 (CONTRACT-GUIDE §8). */
class ProblemAdviceTest {

    private final ProblemAdvice advice = new ProblemAdvice(new ProblemWriter(JsonMapper.builder().build()));

    @Test
    void mapsAnUnreachableDatabaseToNotReadyWithRetryAfter() throws Exception {
        MockHttpServletRequest req = new MockHttpServletRequest("GET", "/v1/storms/2013306N07162");
        MockHttpServletResponse res = new MockHttpServletResponse();

        advice.databaseUnavailable(new CannotGetJdbcConnectionException(
                "Failed to obtain JDBC Connection", new java.sql.SQLTransientConnectionException("tr - Connection is not available")),
                req, res);

        assertThat(res.getStatus()).isEqualTo(503);
        assertThat(res.getContentType()).startsWith(ProblemWriter.MEDIA_TYPE);
        assertThat(res.getHeader("Retry-After")).isEqualTo(ProblemAdvice.DATABASE_RETRY_AFTER_S);
        assertThat(res.getHeader("Cache-Control")).isEqualTo("no-store");
        assertThat(res.getContentAsString()).contains("\"code\":\"not-ready\"", "\"status\":503")
                .doesNotContain("JDBC", "Connection is not available");
    }
}
