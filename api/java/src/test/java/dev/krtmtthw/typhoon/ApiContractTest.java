package dev.krtmtthw.typhoon;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.containsString;
import static org.hamcrest.Matchers.hasSize;
import static org.hamcrest.Matchers.matchesPattern;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.ResultMatcher;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

/**
 * The application against PostGIS with the contract schema and fixture: every response here is also validated
 * against {@code contracts/dist/openapi.json} by {@link ContractMatcher} (status, headers, media type, body
 * schema), so drift from the contract fails the build before the conformance suite runs.
 */
@SpringBootTest(properties = {"tr.site-origin=http://localhost:8788", "tr.test-hooks=true", "tr.rate-limit-per-minute=0"})
@AutoConfigureMockMvc
@Import(ContractDatabase.class)
class ApiContractTest {

    private static final String SPEC = "file:" + System.getProperty("tr.contract", "../../contracts/dist/openapi.json");
    private static final String HAIYAN = "2013306N07162";
    private static final String TACLOBAN = "PH-0831600000";

    @Autowired
    MockMvc mvc;

    @BeforeAll
    static void fixture() {
        ContractDatabase.reseed();
    }

    private static MockHttpServletRequestBuilder proxied(MockHttpServletRequestBuilder b) {
        return b.header("X-Forwarded-Prefix", "/api/java");
    }

    private static ResultMatcher contract() {
        return ContractMatcher.conforms();
    }

    @Test
    void listsStormsInSeasonOrderWithCursorAndLink() throws Exception {
        mvc.perform(proxied(get("/v1/storms?limit=2")))
                .andExpect(status().isOk()).andExpect(contract())
                .andExpect(jsonPath("$.items[*].sid").value(org.hamcrest.Matchers.contains("2023207N09141", "2022254N24143")))
                .andExpect(header().string("Link", containsString("<http://localhost:8788/api/java/v1/storms?limit=2&cursor=")))
                .andExpect(header().string("Cache-Control", "public, max-age=300, stale-while-revalidate=86400"))
                .andExpect(header().string("ETag", matchesPattern("W/\"d1-[0-9a-f]{16}\"")))
                .andExpect(header().string("X-Backend-Impl", "java"));
    }

    @Test
    void answersIfNoneMatchWith304() throws Exception {
        MvcResult first = mvc.perform(get("/v1/storms/" + HAIYAN)).andExpect(status().isOk()).andExpect(contract()).andReturn();
        String etag = first.getResponse().getHeader("ETag");
        mvc.perform(get("/v1/storms/" + HAIYAN).header("If-None-Match", etag))
                .andExpect(status().isNotModified())
                .andExpect(header().string("ETag", etag));
    }

    @Test
    void servesTheBestTrackAsGeoJson() throws Exception {
        mvc.perform(get("/v1/storms/" + HAIYAN + "/track"))
                .andExpect(status().isOk()).andExpect(contract())
                .andExpect(header().string("Content-Type", containsString("application/geo+json")))
                .andExpect(jsonPath("$.features", hasSize(38)));
    }

    @Test
    void ranksStormsThatHitTaclobanAndAPoint() throws Exception {
        mvc.perform(get("/v1/places/" + TACLOBAN + "/storms?radiusKm=100"))
                .andExpect(status().isOk()).andExpect(contract())
                .andExpect(jsonPath("$.items[0].storm.sid").value(HAIYAN))
                .andExpect(jsonPath("$.items[0].closestApproachKm").value(27))
                .andExpect(jsonPath("$.items[0].hoursWithinRadius").value(6));
        mvc.perform(get("/v1/hits?lat=11.2433&lon=125.0039&radiusKm=100"))
                .andExpect(status().isOk()).andExpect(contract())
                .andExpect(jsonPath("$.items[0].storm.sid").value(HAIYAN));
        mvc.perform(get("/v1/storms/" + HAIYAN + "/places?radiusKm=100"))
                .andExpect(status().isOk()).andExpect(contract())
                .andExpect(jsonPath("$.items[*].place.id").value(org.hamcrest.Matchers.contains(
                        "PH-0803738000", "PH-0802616000", TACLOBAN)));
    }

    @Test
    void searchesAndLocatesPlaces() throws Exception {
        mvc.perform(get("/v1/places/search?q=taclo")).andExpect(status().isOk()).andExpect(contract())
                .andExpect(jsonPath("$.items[0].id").value(TACLOBAN));
        mvc.perform(get("/v1/places/nearest?lat=11.2433&lon=125.0039")).andExpect(status().isOk()).andExpect(contract())
                .andExpect(jsonPath("$.contains").value(true));
        mvc.perform(get("/v1/places/" + TACLOBAN)).andExpect(status().isOk()).andExpect(contract())
                .andExpect(jsonPath("$.geometry.type").value("MultiPolygon"));
    }

    @Test
    void reportsProblemsWithContractCodes() throws Exception {
        mvc.perform(get("/v1/storms?limit=500")).andExpect(status().isBadRequest()).andExpect(contract())
                .andExpect(jsonPath("$.code").value("validation"))
                .andExpect(jsonPath("$.errors[0].pointer").value("#/query/limit"));
        mvc.perform(get("/v1/storms/1999001N00000")).andExpect(status().isNotFound()).andExpect(contract())
                .andExpect(header().string("Cache-Control", "public, max-age=60"));
        mvc.perform(get("/v1/no-such-route")).andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("not-found"));
        mvc.perform(get("/v1/hits?lat=0&lon=1&sort=")).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.errors[0].pointer").value("#/query/sort"));
        mvc.perform(get("/v1/storms?=x&limit=2")).andExpect(status().isOk());
        mvc.perform(request(HttpMethod.PUT, "/v1/storms")).andExpect(status().isMethodNotAllowed())
                .andExpect(header().string("Allow", containsString("GET")));
    }

    /** Contract 2.0.0 (CONTRACT-GUIDE §9, §14): no accounts, no cookies, no CSRF. */
    @Test
    void hasNoAccountsCookiesOrCsrf() throws Exception {
        for (String path : new String[] {"/v1/me", "/v1/me/places", "/v1/me/alerts", "/v1/auth/providers",
                "/v1/auth/github/login", "/v1/alerts/unsubscribe?token=x"}) {
            mvc.perform(get(path)).andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("not-found"))
                    .andExpect(header().doesNotExist("Set-Cookie"));
        }
        mvc.perform(post("/v1/auth/logout")).andExpect(status().isNotFound());
        mvc.perform(post("/v1/_test/sessions").contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andExpect(status().isNotFound());
        // Cookies are ignored: same ETag and body, publicly cacheable, no Vary: Cookie, nothing set.
        MvcResult plain = mvc.perform(get("/v1/places/" + TACLOBAN)).andExpect(status().isOk()).andReturn();
        mvc.perform(get("/v1/places/" + TACLOBAN).cookie(new jakarta.servlet.http.Cookie("__Host-tr_session", "x")))
                .andExpect(status().isOk()).andExpect(contract())
                .andExpect(header().string("ETag", plain.getResponse().getHeader("ETag")))
                .andExpect(header().string("Cache-Control", "public, max-age=300, stale-while-revalidate=86400"))
                .andExpect(header().string("Vary", "Accept-Encoding"))
                .andExpect(header().doesNotExist("Set-Cookie"))
                .andExpect(header().string("X-Content-Type-Options", "nosniff"))
                .andExpect(header().string("X-Frame-Options", "DENY"));
        // Unsafe methods need no Origin / X-Requested-With: public paths answer 405 with Allow.
        mvc.perform(post("/v1/storms").contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andExpect(status().isMethodNotAllowed()).andExpect(jsonPath("$.code").value("method-not-allowed"))
                .andExpect(header().string("Allow", containsString("GET")));
    }

    @Test
    void validatesTestHookBodies() throws Exception {
        mvc.perform(post("/v1/_test/live-events").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"type\":\"nope\",\"payload\":{}}"))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("validation"));
        mvc.perform(post("/v1/_test/live-events").contentType(MediaType.TEXT_PLAIN).content("x"))
                .andExpect(status().isUnsupportedMediaType()).andExpect(jsonPath("$.code").value("unsupported-media-type"));
    }

    @Test
    void servesTheLiveSnapshotAndTheContractBundle() throws Exception {
        mvc.perform(get("/v1/live/storms")).andExpect(status().isOk()).andExpect(contract())
                .andExpect(header().string("Cache-Control", "no-cache"))
                .andExpect(header().string("ETag", matchesPattern("W/\"s\\d+\"")));
        MvcResult bundle = mvc.perform(get("/v1/openapi.json")).andExpect(status().isOk()).andReturn();
        byte[] onDisk = java.nio.file.Files.readAllBytes(java.nio.file.Path.of(SPEC.substring("file:".length())));
        assertThat(bundle.getResponse().getContentAsByteArray()).isEqualTo(onDisk);
    }

    @Test
    void readinessReportsTheSchemaVersion() throws Exception {
        mvc.perform(get("/readyz")).andExpect(status().isOk()).andExpect(contract())
                .andExpect(jsonPath("$.schemaVersion").value("20261021000600"));
        mvc.perform(get("/healthz")).andExpect(status().isOk()).andExpect(contract());
    }
}
