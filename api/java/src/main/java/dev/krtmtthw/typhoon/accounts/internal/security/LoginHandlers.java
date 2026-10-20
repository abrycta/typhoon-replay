package dev.krtmtthw.typhoon.accounts.internal.security;

import java.io.IOException;
import java.util.Set;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.oauth2.client.authentication.OAuth2AuthenticationToken;
import org.springframework.security.oauth2.core.OAuth2AuthenticationException;
import org.springframework.security.oauth2.core.user.OAuth2User;
import org.springframework.security.web.authentication.AuthenticationFailureHandler;
import org.springframework.security.web.authentication.AuthenticationSuccessHandler;

import dev.krtmtthw.typhoon.accounts.internal.SessionCookie;
import dev.krtmtthw.typhoon.accounts.internal.SessionStore;
import dev.krtmtthw.typhoon.accounts.internal.UserAccounts;
import dev.krtmtthw.typhoon.shared.problem.ProblemType;
import dev.krtmtthw.typhoon.shared.problem.ProblemWriter;

/**
 * End of the OAuth callback. Success: upsert the user and identity, mint an {@code auth.session} row, set the cookie and
 * redirect (302) to {@code returnTo}. Failure: 302 to {@code /signin?error=access-denied|invalid-state|provider-error},
 * no cookie. Locations are relative, so they resolve against the browser-visible origin.
 */
class LoginHandlers implements AuthenticationSuccessHandler, AuthenticationFailureHandler {

    private static final Logger LOG = LoggerFactory.getLogger(LoginHandlers.class);
    private static final Set<String> INVALID_STATE = Set.of("authorization_request_not_found", "invalid_request",
            "invalid_state_parameter", "client_registration_not_found");
    private static final Set<String> PROVIDERS = Set.of("github", "google");

    private final UserAccounts users;
    private final SessionStore sessions;
    private final ProblemWriter problems;

    LoginHandlers(UserAccounts users, SessionStore sessions, ProblemWriter problems) {
        this.users = users;
        this.sessions = sessions;
        this.problems = problems;
    }

    @Override
    public void onAuthenticationSuccess(HttpServletRequest request, HttpServletResponse response, Authentication auth)
            throws IOException {
        OAuth2AuthenticationToken token = (OAuth2AuthenticationToken) auth;
        UserAccounts.Identity identity = identity(token.getAuthorizedClientRegistrationId(), token.getPrincipal());
        var user = users.upsert(identity);
        SessionStore.Created session = sessions.create(user, request.getHeader(HttpHeaders.USER_AGENT));
        SessionCookie.set(response, session.token());
        Object returnTo = request.getAttribute(OAuthState.RETURN_TO_ATTRIBUTE);
        redirect(response, returnTo == null ? "/" : LoginRequestResolver.safeReturnTo(returnTo.toString()));
    }

    @Override
    public void onAuthenticationFailure(HttpServletRequest request, HttpServletResponse response,
            AuthenticationException exception) throws IOException {
        String provider = request.getRequestURI().replaceAll(".*/auth/([^/]+)/callback$", "$1");
        if (!PROVIDERS.contains(provider)) {
            problems.write(request, response, ProblemType.NOT_FOUND, "Unknown sign-in provider.");
            return;
        }
        String code = "provider-error";
        if (exception instanceof OAuth2AuthenticationException e) {
            String error = e.getError().getErrorCode();
            if (INVALID_STATE.contains(error)) {
                code = "invalid-state";
            } else if ("access_denied".equals(error)) {
                code = "access-denied";
            } else {
                LOG.warn("sign-in with {} failed: {}", provider, error);
            }
        }
        redirect(response, "/signin?error=" + code);
    }

    private static void redirect(HttpServletResponse response, String location) {
        response.setStatus(HttpServletResponse.SC_FOUND);
        response.setHeader(HttpHeaders.LOCATION, location);
    }

    static UserAccounts.Identity identity(String provider, OAuth2User user) {
        if ("github".equals(provider)) {
            Object name = user.getAttribute("name");
            return new UserAccounts.Identity(provider, String.valueOf(user.getAttributes().get("id")), user.getAttribute("email"),
                    Boolean.TRUE.equals(user.getAttribute("email_verified")) || user.getAttribute("email") != null,
                    name != null ? name.toString() : user.getAttribute("login"), user.getAttribute("avatar_url"));
        }
        return new UserAccounts.Identity(provider, user.getAttribute("sub"), user.getAttribute("email"),
                Boolean.TRUE.equals(user.getAttribute("email_verified")), user.getAttribute("name"), user.getAttribute("picture"));
    }
}
