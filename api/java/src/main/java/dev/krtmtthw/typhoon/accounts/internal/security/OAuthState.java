package dev.krtmtthw.typhoon.accounts.internal.security;

import java.util.Map;
import java.util.Optional;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.oauth2.client.registration.ClientRegistration;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.security.oauth2.client.web.AuthorizationRequestRepository;
import org.springframework.security.oauth2.core.endpoint.OAuth2AuthorizationRequest;
import org.springframework.security.oauth2.core.endpoint.OAuth2ParameterNames;
import org.springframework.security.oauth2.core.endpoint.PkceParameterNames;

import dev.krtmtthw.typhoon.shared.web.RequestContext;

/**
 * Spring Security's {@link AuthorizationRequestRepository} over the shared {@code auth.oauth_state} table
 * (CONTRACT-GUIDE §9): state, PKCE verifier, provider and returnTo, 10-minute TTL, single use
 * ({@code DELETE ... RETURNING}). Nothing is kept in process memory or an HTTP session, so a flow started on any
 * backend completes on any other.
 *
 * <p>The table has no {@code redirect_uri} column, and the token request must repeat the redirect URI the flow
 * started with. It is rebuilt from {@code created_by_impl}: the edge proxy mounts every backend at
 * {@code /api/{impl}}, so the starting backend's callback is {@code TR_SITE_ORIGIN/api/{impl}/v1/auth/{provider}/callback}.
 * For this backend's own flows the current {@code X-Forwarded-Prefix} is used, as at login.
 */
class OAuthState implements AuthorizationRequestRepository<OAuth2AuthorizationRequest> {

    static final String RETURN_TO = "return_to";
    static final String RETURN_TO_ATTRIBUTE = "tr.returnTo";

    private final JdbcClient jdbc;
    private final ClientRegistrationRepository registrations;
    private final String siteOrigin;
    private final String impl;

    OAuthState(JdbcClient jdbc, ClientRegistrationRepository registrations, String siteOrigin, String impl) {
        this.jdbc = jdbc;
        this.registrations = registrations;
        this.siteOrigin = siteOrigin;
        this.impl = impl;
    }

    @Override
    public OAuth2AuthorizationRequest loadAuthorizationRequest(HttpServletRequest request) {
        String state = request.getParameter(OAuth2ParameterNames.STATE);
        if (state == null) {
            return null;
        }
        return jdbc.sql("SELECT provider, pkce_verifier, return_to, created_by_impl FROM auth.oauth_state WHERE state = :s AND expires_at > now()")
                .param("s", state).query((rs, n) -> rebuild(request, state, rs.getString(1), rs.getString(2), rs.getString(3),
                        rs.getString(4))).list().stream().filter(java.util.Objects::nonNull).findFirst().orElse(null);
    }

    @Override
    public void saveAuthorizationRequest(OAuth2AuthorizationRequest authorizationRequest, HttpServletRequest request,
            HttpServletResponse response) {
        if (authorizationRequest == null) {
            return;
        }
        Map<String, Object> attrs = authorizationRequest.getAttributes();
        jdbc.sql("""
                INSERT INTO auth.oauth_state (state, provider, pkce_verifier, return_to, created_by_impl)
                VALUES (:state, :provider, :verifier, :returnTo, :impl)""")
                .param("state", authorizationRequest.getState())
                .param("provider", attrs.get(OAuth2ParameterNames.REGISTRATION_ID))
                .param("verifier", attrs.get(PkceParameterNames.CODE_VERIFIER))
                .param("returnTo", attrs.getOrDefault(RETURN_TO, "/"))
                .param("impl", impl)
                .update();
    }

    @Override
    public OAuth2AuthorizationRequest removeAuthorizationRequest(HttpServletRequest request, HttpServletResponse response) {
        String state = request.getParameter(OAuth2ParameterNames.STATE);
        if (state == null || state.length() > 128) {
            return null;
        }
        Optional<OAuth2AuthorizationRequest> consumed = jdbc.sql("""
                DELETE FROM auth.oauth_state WHERE state = :s
                RETURNING provider, pkce_verifier, return_to, created_by_impl, expires_at > now() AS live""")
                .param("s", state)
                .query((rs, n) -> rs.getBoolean("live")
                        ? rebuild(request, state, rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4))
                        : null)
                .list().stream().filter(java.util.Objects::nonNull).findFirst();
        OAuth2AuthorizationRequest found = consumed.orElse(null);
        if (found == null || !request.getRequestURI().endsWith("/auth/" + found.getAttribute(OAuth2ParameterNames.REGISTRATION_ID) + "/callback")) {
            return null; // unknown, expired, reused, or a state minted for the other provider
        }
        request.setAttribute(RETURN_TO_ATTRIBUTE, found.getAttribute(RETURN_TO));
        return found;
    }

    private OAuth2AuthorizationRequest rebuild(HttpServletRequest request, String state, String provider, String verifier,
            String returnTo, String createdBy) {
        ClientRegistration reg = registrations.findByRegistrationId(provider);
        if (reg == null) {
            return null;
        }
        String prefix = impl.equals(createdBy) ? RequestContext.forwardedPrefix(request) : "/api/" + createdBy;
        return OAuth2AuthorizationRequest.authorizationCode()
                .authorizationUri(reg.getProviderDetails().getAuthorizationUri())
                .clientId(reg.getClientId())
                .redirectUri(siteOrigin + prefix + "/v1/auth/" + provider + "/callback")
                .scopes(reg.getScopes())
                .state(state)
                .attributes(a -> {
                    a.put(OAuth2ParameterNames.REGISTRATION_ID, provider);
                    a.put(PkceParameterNames.CODE_VERIFIER, verifier);
                    a.put(RETURN_TO, returnTo);
                })
                .build();
    }
}
