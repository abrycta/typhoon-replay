package dev.krtmtthw.typhoon.accounts.web;

import java.util.Map;
import java.util.Set;
import java.util.UUID;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import dev.krtmtthw.typhoon.accounts.internal.SessionCookie;
import dev.krtmtthw.typhoon.accounts.internal.SessionStore;
import dev.krtmtthw.typhoon.accounts.internal.UserAccounts;
import dev.krtmtthw.typhoon.shared.TrProperties;
import dev.krtmtthw.typhoon.shared.problem.ApiException;
import dev.krtmtthw.typhoon.shared.web.WebConfig;

/**
 * Test hook {@code POST /v1/_test/sessions} (CONTRACT-GUIDE §10): signs in without a provider. Only with
 * {@code TR_TEST_HOOKS=1}, otherwise 404 {@code not-found}. Not CSRF-checked; absent from the public bundle.
 */
@RestController
class TestSessionController {

    private static final Set<String> PROVIDERS = Set.of("github", "google");

    private final boolean enabled;
    private final UserAccounts users;
    private final SessionStore sessions;

    TestSessionController(TrProperties props, UserAccounts users, SessionStore sessions) {
        this.enabled = props.testHooks();
        this.users = users;
        this.sessions = sessions;
    }

    record TestSessionRequest(String email, String provider, String displayName) {}

    @PostMapping("/v1/_test/sessions")
    ResponseEntity<Map<String, Object>> create(@RequestBody(required = false) TestSessionRequest body,
            HttpServletRequest request, HttpServletResponse response) {
        if (!enabled) {
            throw ApiException.notFound("No such resource.");
        }
        if (body == null || body.email() == null || !body.email().matches("[^@\\s]+@[^@\\s]+")) {
            throw ApiException.validation("#/body/email", "must be an email address");
        }
        if (body.provider() == null || !PROVIDERS.contains(body.provider())) {
            throw ApiException.validation("#/body/provider", "must be google or github");
        }
        UUID user = users.upsert(new UserAccounts.Identity(body.provider(), "test:" + body.email(), body.email(), true,
                body.displayName(), null));
        SessionStore.Created session = sessions.create(user, request.getHeader(HttpHeaders.USER_AGENT));
        SessionCookie.set(response, session.token());
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(Map.of("userId", user, "expiresAt", WebConfig.format(session.expiresAt())));
    }
}
