package dev.krtmtthw.typhoon.accounts.web;

import java.util.List;
import java.util.Map;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

import dev.krtmtthw.typhoon.accounts.internal.SessionCookie;
import dev.krtmtthw.typhoon.accounts.internal.SessionStore;
import dev.krtmtthw.typhoon.contract.api.AuthApi;
import dev.krtmtthw.typhoon.contract.model.AuthProvider;
import dev.krtmtthw.typhoon.contract.model.AuthProviderList;
import dev.krtmtthw.typhoon.contract.model.Provider;
import dev.krtmtthw.typhoon.shared.problem.ApiException;

/**
 * Sign-in (tag {@code auth}). Login and callback are served by Spring Security's {@code oauth2Login} filters; the
 * handler below only answers what those filters decline: an unknown provider (404) or an over-long {@code returnTo}
 * (400).
 */
@RestController
class AuthController implements AuthApi {

    private static final Map<String, String> PROVIDERS = Map.of("google", "Google", "github", "GitHub");

    private final SessionStore sessions;
    private final HttpServletRequest request;
    private final HttpServletResponse response;

    AuthController(SessionStore sessions, HttpServletRequest request, HttpServletResponse response) {
        this.sessions = sessions;
        this.request = request;
        this.response = response;
    }

    @Override
    public ResponseEntity<AuthProviderList> listAuthProviders() {
        return ResponseEntity.ok(new AuthProviderList(List.of(
                new AuthProvider(Provider.GOOGLE, PROVIDERS.get("google")),
                new AuthProvider(Provider.GITHUB, PROVIDERS.get("github")))));
    }

    /** Revokes the session everywhere (shared table) and clears the cookie; 204 even without a session. */
    @Override
    public ResponseEntity<Void> logout() {
        sessions.revoke(SessionCookie.read(request));
        SessionCookie.clear(response);
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/v1/auth/{provider}/login")
    ResponseEntity<Void> loginDeclined(@PathVariable String provider) {
        if (!PROVIDERS.containsKey(provider)) {
            throw ApiException.notFound("Unknown sign-in provider.");
        }
        throw ApiException.validation("#/query/returnTo", "must be at most 512 characters");
    }
}
