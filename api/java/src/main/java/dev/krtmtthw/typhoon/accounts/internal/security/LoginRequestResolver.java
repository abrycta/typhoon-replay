package dev.krtmtthw.typhoon.accounts.internal.security;

import java.net.URI;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;

import org.springframework.http.HttpMethod;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.security.oauth2.client.web.DefaultOAuth2AuthorizationRequestResolver;
import org.springframework.security.oauth2.client.web.OAuth2AuthorizationRequestCustomizers;
import org.springframework.security.oauth2.client.web.OAuth2AuthorizationRequestResolver;
import org.springframework.security.oauth2.core.endpoint.OAuth2AuthorizationRequest;
import org.springframework.security.web.servlet.util.matcher.PathPatternRequestMatcher;
import org.springframework.security.web.util.matcher.RequestMatcher;

import dev.krtmtthw.typhoon.shared.web.RequestContext;

/**
 * {@code GET /v1/auth/{provider}/login?returnTo=}: Spring Security's default resolver with PKCE S256, mounted at the
 * contract's path, with {@code redirect_uri} built from {@code TR_SITE_ORIGIN} + {@code X-Forwarded-Prefix} (never the
 * Render host) and a sanitised {@code returnTo} carried as an attribute into {@code auth.oauth_state}.
 * Returns null (so MVC answers 400/404) for an unknown provider or an over-long {@code returnTo}.
 */
class LoginRequestResolver implements OAuth2AuthorizationRequestResolver {

    static final String LOGIN_PATH = "/v1/auth/{provider}/login";
    private static final int MAX_RETURN_TO = 512;

    private final RequestMatcher matcher = PathPatternRequestMatcher.withDefaults().matcher(HttpMethod.GET, LOGIN_PATH);
    private final ClientRegistrationRepository registrations;
    private final DefaultOAuth2AuthorizationRequestResolver delegate;
    private final URI site;

    LoginRequestResolver(ClientRegistrationRepository registrations, String siteOrigin) {
        this.registrations = registrations;
        this.site = URI.create(siteOrigin);
        this.delegate = new DefaultOAuth2AuthorizationRequestResolver(registrations, "/v1/auth");
        this.delegate.setAuthorizationRequestCustomizer(OAuth2AuthorizationRequestCustomizers.withPkce());
    }

    @Override
    public OAuth2AuthorizationRequest resolve(HttpServletRequest request) {
        RequestMatcher.MatchResult match = matcher.matcher(request);
        if (!match.isMatch()) {
            return null;
        }
        return resolve(request, match.getVariables().get("provider"));
    }

    @Override
    public OAuth2AuthorizationRequest resolve(HttpServletRequest request, String provider) {
        if (provider == null || registrations.findByRegistrationId(provider) == null) {
            return null;
        }
        String returnTo = request.getParameter("returnTo");
        if (returnTo != null && returnTo.length() > MAX_RETURN_TO) {
            return null;
        }
        OAuth2AuthorizationRequest built = delegate.resolve(new PublicBaseRequest(request, site), provider);
        if (built == null) {
            return null;
        }
        String safe = safeReturnTo(returnTo);
        return OAuth2AuthorizationRequest.from(built).attributes(a -> a.put(OAuthState.RETURN_TO, safe)).build();
    }

    /** A same-origin relative path starting with {@code /} and not {@code //} (nor {@code /\}); anything else is {@code /}. */
    static String safeReturnTo(String returnTo) {
        if (returnTo == null || !returnTo.startsWith("/") || returnTo.startsWith("//") || returnTo.startsWith("/\\")) {
            return "/";
        }
        for (int i = 0; i < returnTo.length(); i++) {
            if (Character.isISOControl(returnTo.charAt(i))) {
                return "/";
            }
        }
        return returnTo;
    }

    /**
     * Presents the request as the browser saw it (site origin + forwarded prefix), so the registration's
     * {@code {baseUrl}/v1/auth/{registrationId}/callback} template expands to the public callback URI.
     */
    private static final class PublicBaseRequest extends HttpServletRequestWrapper {

        private final URI site;
        private final String prefix;

        PublicBaseRequest(HttpServletRequest request, URI site) {
            super(request);
            this.site = site;
            this.prefix = RequestContext.forwardedPrefix(request);
        }

        @Override
        public String getScheme() {
            return site.getScheme();
        }

        @Override
        public String getServerName() {
            return site.getHost();
        }

        @Override
        public int getServerPort() {
            if (site.getPort() > 0) {
                return site.getPort();
            }
            return "https".equals(site.getScheme()) ? 443 : 80;
        }

        @Override
        public String getContextPath() {
            return prefix;
        }

        @Override
        public String getRequestURI() {
            return prefix + super.getRequestURI();
        }

        @Override
        public StringBuffer getRequestURL() {
            String port = site.getPort() > 0 ? ":" + site.getPort() : "";
            return new StringBuffer(site.getScheme() + "://" + site.getHost() + port + getRequestURI());
        }
    }
}
