package dev.krtmtthw.typhoon.accounts.internal.security;

import java.util.List;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.client.OAuth2AuthorizedClient;
import org.springframework.security.oauth2.client.registration.ClientRegistration;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.security.oauth2.client.registration.InMemoryClientRegistrationRepository;
import org.springframework.security.oauth2.client.web.OAuth2AuthorizedClientRepository;
import org.springframework.security.oauth2.core.AuthorizationGrantType;
import org.springframework.security.oauth2.core.ClientAuthenticationMethod;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.context.SecurityContextHolderFilter;
import org.springframework.security.web.savedrequest.NullRequestCache;

import dev.krtmtthw.typhoon.accounts.internal.SessionStore;
import dev.krtmtthw.typhoon.accounts.internal.UserAccounts;
import dev.krtmtthw.typhoon.shared.TrProperties;
import dev.krtmtthw.typhoon.shared.problem.ProblemType;
import dev.krtmtthw.typhoon.shared.problem.ProblemWriter;

/**
 * Spring Security 7, stateless: no HTTP session, no saved requests, no default headers that would override the
 * contract's Cache-Control. Authentication comes from the shared {@code auth.session} table
 * ({@link SessionSecurityContextRepository}); sign-in is {@code oauth2Login} with the contract's paths, state in
 * {@code auth.oauth_state} ({@link OAuthState}), PKCE S256 and the userinfo endpoints.
 */
@Configuration(proxyBeanMethods = false)
class SecurityConfig {

    @Bean
    ClientRegistrationRepository clientRegistrations(TrProperties props) {
        return new InMemoryClientRegistrationRepository(
                registration("github", "GitHub", props.oauth().get("github"), "id", List.of("read:user", "user:email")),
                registration("google", "Google", props.oauth().get("google"), "sub", List.of("email", "profile")));
    }

    private static ClientRegistration registration(String id, String name, TrProperties.OAuthProvider p, String nameAttribute,
            List<String> scopes) {
        return ClientRegistration.withRegistrationId(id)
                .clientName(name)
                .clientId(p.clientId())
                .clientSecret(p.clientSecret())
                .clientAuthenticationMethod(ClientAuthenticationMethod.CLIENT_SECRET_POST)
                .authorizationGrantType(AuthorizationGrantType.AUTHORIZATION_CODE)
                .redirectUri("{baseUrl}/v1/auth/{registrationId}/callback")
                .scope(scopes)
                .authorizationUri(p.authUrl())
                .tokenUri(p.tokenUrl())
                .userInfoUri(p.userinfoUrl())
                .userNameAttributeName(nameAttribute)
                .build();
    }

    @Bean
    SecurityFilterChain api(HttpSecurity http, TrProperties props, JdbcClient jdbc, ClientRegistrationRepository registrations,
            SessionStore sessions, UserAccounts users, ProblemWriter problems) throws Exception {
        LoginHandlers handlers = new LoginHandlers(users, sessions, problems);
        OAuthState state = new OAuthState(jdbc, registrations, props.siteOrigin(), props.impl());
        http
                .securityContext(c -> c.securityContextRepository(new SessionSecurityContextRepository(sessions)))
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .requestCache(r -> r.requestCache(new NullRequestCache()))
                .csrf(c -> c.disable())
                .formLogin(f -> f.disable())
                .httpBasic(b -> b.disable())
                .logout(l -> l.disable())
                .anonymous(a -> {})
                .headers(h -> h.cacheControl(cc -> cc.disable()))
                .addFilterAfter(new OriginCsrfFilter(props.csrfOrigins(), problems), SecurityContextHolderFilter.class)
                .authorizeHttpRequests(a -> a
                        .requestMatchers(HttpMethod.GET, "/v1/me", "/v1/me/places", "/v1/me/alerts").authenticated()
                        .requestMatchers(HttpMethod.DELETE, "/v1/me", "/v1/me/places/*").authenticated()
                        .requestMatchers(HttpMethod.POST, "/v1/me/places").authenticated()
                        .requestMatchers(HttpMethod.PATCH, "/v1/me/places/*").authenticated()
                        .requestMatchers(HttpMethod.PUT, "/v1/me/alerts").authenticated()
                        .anyRequest().permitAll())
                .exceptionHandling(e -> e
                        .authenticationEntryPoint((req, res, ex) ->
                                problems.write(req, res, ProblemType.UNAUTHENTICATED, "Sign in first."))
                        .accessDeniedHandler((req, res, ex) ->
                                problems.write(req, res, ProblemType.FORBIDDEN, "Not allowed.")))
                .oauth2Login(o -> o
                        .loginPage("/v1/auth/providers")
                        .clientRegistrationRepository(registrations)
                        .authorizedClientRepository(new NoTokenStorage())
                        .authorizationEndpoint(a -> a
                                .authorizationRequestResolver(new LoginRequestResolver(registrations, props.siteOrigin()))
                                .authorizationRequestRepository(state))
                        .redirectionEndpoint(r -> r.baseUri("/v1/auth/*/callback"))
                        .userInfoEndpoint(u -> u.userService(new ProviderUserService()))
                        .successHandler(handlers)
                        .failureHandler(handlers));
        return http.build();
    }

    /**
     * Query strings are parsed leniently and validated against the contract (tolerant reader), so the firewall's
     * parameter checks would only turn odd-but-harmless input into errors. Path and header checks stay on.
     */
    @Bean
    org.springframework.security.web.firewall.HttpFirewall firewall() {
        var firewall = new org.springframework.security.web.firewall.StrictHttpFirewall();
        firewall.setAllowedParameterNames(name -> true);
        firewall.setAllowedParameterValues(value -> true);
        return firewall;
    }

    /** Anything the firewall still rejects becomes a 400 problem, not the container's error page. */
    @Bean
    org.springframework.security.web.firewall.RequestRejectedHandler requestRejected(ProblemWriter problems) {
        return (req, res, ex) -> problems.write(req, res, ProblemType.VALIDATION, "The request was rejected as malformed.");
    }

    /** Provider access and refresh tokens are never stored (CONTRACT-GUIDE §9). */
    private static final class NoTokenStorage implements OAuth2AuthorizedClientRepository {

        @Override
        public <T extends OAuth2AuthorizedClient> T loadAuthorizedClient(String id, Authentication principal,
                HttpServletRequest request) {
            return null;
        }

        @Override
        public void saveAuthorizedClient(OAuth2AuthorizedClient client, Authentication principal, HttpServletRequest request,
                HttpServletResponse response) {
            // dropped on purpose
        }

        @Override
        public void removeAuthorizedClient(String id, Authentication principal, HttpServletRequest request,
                HttpServletResponse response) {
            // nothing stored
        }
    }
}
