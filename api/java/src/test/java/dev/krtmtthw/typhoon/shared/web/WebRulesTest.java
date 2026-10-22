package dev.krtmtthw.typhoon.shared.web;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Set;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import dev.krtmtthw.typhoon.shared.TrProperties;
import dev.krtmtthw.typhoon.shared.problem.ApiException;
import dev.krtmtthw.typhoon.shared.problem.ProblemType;

/** CONTRACT-GUIDE §5 (cursors) and §6 (ETags), checked without a server. */
class WebRulesTest {

    @Test
    void encodesCursorsAsBase64urlJsonWithShortestNumbers() {
        String c = Cursor.encode("closest", new BigDecimal("27.0"), "2013306N07162");
        String json = new String(Base64.getUrlDecoder().decode(c), StandardCharsets.UTF_8);
        assertThat(json).isEqualTo("[1,\"closest\",27,\"2013306N07162\"]");
        assertThat(c).doesNotContain("=");
    }

    @Test
    void acceptsAnyBackendsCursorAndComparesNumbersAsJsonValues() {
        String foreign = Base64.getUrlEncoder().withoutPadding()
                .encodeToString("[1,\"closest\",27.00,\"2013306N07162\"]".getBytes(StandardCharsets.UTF_8));
        Cursor c = Cursor.decode(foreign, "closest", Cursor.Kind.NUMBER);
        assertThat(c.number(0)).isEqualByComparingTo("27");
        assertThat(c.lastId()).isEqualTo("2013306N07162");
    }

    @Test
    void rejectsMalformedAndForeignSortCursors() {
        assertThatThrownBy(() -> Cursor.decode("bm90LWpzb24", "season-desc", Cursor.Kind.NUMBER))
                .isInstanceOfSatisfying(ApiException.class, e -> assertThat(e.type()).isEqualTo(ProblemType.INVALID_CURSOR));
        String nameCursor = Cursor.encode("name", "HAIYAN", "2013306N07162");
        assertThatThrownBy(() -> Cursor.decode(nameCursor, "season-desc", Cursor.Kind.NUMBER))
                .isInstanceOf(ApiException.class);
        String wrongKind = Cursor.encode("season-desc", "2013", "2013306N07162");
        assertThatThrownBy(() -> Cursor.decode(wrongKind, "season-desc", Cursor.Kind.NUMBER)).isInstanceOf(ApiException.class);
    }

    @Test
    void canonicalRequestSortsRecognisedParametersAndDropsUnknownOnes() {
        MockHttpServletRequest req = new MockHttpServletRequest("GET", "/v1/storms");
        req.addParameter("season", "2013");
        req.addParameter("limit", "5");
        req.addParameter("utm_source", "x");
        assertThat(Etags.canonicalRequest(req, Set.of("season", "limit"))).isEqualTo("/v1/storms?limit=5&season=2013");
    }

    @Test
    void percentEncodesPerRfc3986WithUppercaseHex() {
        assertThat(Etags.percentEncode("台風 a~b")).isEqualTo("%E5%8F%B0%E9%A2%A8%20a~b");
    }

    @Test
    void etagIsDatasetVersionPlus16HexOfTheCanonicalRequest() {
        MockHttpServletRequest req = new MockHttpServletRequest("GET", "/v1/storms/2013306N07162");
        assertThat(Etags.catalogue(1, req, Set.of())).matches("W/\"d1-[0-9a-f]{16}\"")
                .isEqualTo("W/\"d1-" + Etags.resourceKey("/v1/storms/2013306N07162") + "\"");
    }

    @Test
    void ifNoneMatchUsesWeakComparison() {
        String tag = "W/\"d1-3f9a1c0b7e2d4a65\"";
        assertThat(Etags.matches("\"nope\", \"d1-3f9a1c0b7e2d4a65\"", tag)).isTrue();
        assertThat(Etags.matches("*", tag)).isTrue();
        assertThat(Etags.matches("W/\"d2-3f9a1c0b7e2d4a65\"", tag)).isFalse();
    }

    @Test
    void parsesQueriesLenientlyDroppingMalformedChunks() {
        var params = LenientQueryRequest.parse("=false&q=%E5%8F%B0&bad=%ZZ&limit=5&limit=6&flag");
        assertThat(params).containsOnlyKeys("q", "limit", "flag");
        assertThat(params.get("q")).containsExactly("台");
        assertThat(params.get("limit")).containsExactly("5", "6");
    }

    @Test
    void rateLimitTrustsForwardedForOnlyWithTheEdgeSecret() {
        byte[] secret = "s3cret".getBytes(StandardCharsets.UTF_8);
        MockHttpServletRequest edge = new MockHttpServletRequest("GET", "/v1/storms");
        edge.setRemoteAddr("10.0.0.9");
        edge.addHeader("X-Forwarded-For", "203.0.113.7, 2a06:98c0:3600::103");
        edge.addHeader("CF-Connecting-IP", "2a06:98c0:3600::103");
        edge.addHeader("X-Edge-Secret", "s3cret");
        assertThat(RateLimitFilter.clientIp(edge, secret)).isEqualTo("203.0.113.7");

        // A direct caller can't choose its bucket: spoofed headers, a wrong secret, or no secret configured.
        MockHttpServletRequest direct = new MockHttpServletRequest("GET", "/v1/storms");
        direct.setRemoteAddr("10.0.0.9");
        direct.addHeader("X-Forwarded-For", "198.51.100.1");
        direct.addHeader("CF-Connecting-IP", "198.51.100.1");
        direct.addHeader("X-Edge-Secret", "guess");
        assertThat(RateLimitFilter.clientIp(direct, secret)).isEqualTo("10.0.0.9");
        assertThat(RateLimitFilter.clientIp(edge, null)).isEqualTo("10.0.0.9");
    }

    @Test
    void edgeSecretGuardsOnlyV1AndOnlyWhenConfigured() throws Exception {
        EdgeSecretFilter guarded = new EdgeSecretFilter(props("s3cret"));
        assertThat(status(guarded, "/v1/meta", null)).isEqualTo(403);
        assertThat(status(guarded, "/v1/meta", "guess")).isEqualTo(403);
        assertThat(status(guarded, "/v1/meta", "s3cret")).isEqualTo(200);
        assertThat(status(guarded, "/healthz", null)).isEqualTo(200);
        assertThat(status(guarded, "/readyz", null)).isEqualTo(200);
        assertThat(status(new EdgeSecretFilter(props("")), "/v1/meta", null)).isEqualTo(200);
    }

    private static TrProperties props(String edgeSecret) {
        return new TrProperties("java", "https://replay.krtmtthw.dev", false, "0", "test", 600, 200, 6, edgeSecret);
    }

    private static int status(EdgeSecretFilter filter, String path, String secret) throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", path);
        if (secret != null) {
            request.addHeader("X-Edge-Secret", secret);
        }
        MockHttpServletResponse response = new MockHttpServletResponse();
        filter.doFilter(request, response, new MockFilterChain());
        return response.getStatus();
    }

    @Test
    void requestIdsAreEchoedOnlyWhenWellFormed() {
        assertThat(RequestContext.resolveRequestId("conformance.req-01")).isEqualTo("conformance.req-01");
        assertThat(RequestContext.resolveRequestId("bad id")).matches("[0-9a-f-]{36}").contains("-7");
    }
}
