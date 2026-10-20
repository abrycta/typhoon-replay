package dev.krtmtthw.typhoon.accounts.internal.security;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.springframework.core.ParameterizedTypeReference;
import org.springframework.security.oauth2.client.userinfo.DefaultOAuth2UserService;
import org.springframework.security.oauth2.client.userinfo.OAuth2UserRequest;
import org.springframework.security.oauth2.client.userinfo.OAuth2UserService;
import org.springframework.security.oauth2.core.OAuth2AuthenticationException;
import org.springframework.security.oauth2.core.OAuth2Error;
import org.springframework.security.oauth2.core.user.DefaultOAuth2User;
import org.springframework.security.oauth2.core.user.OAuth2User;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

/**
 * Reads the provider's userinfo endpoint (CONTRACT-GUIDE §9: userinfo, never ID tokens, so the mock IdP can stand in
 * for both providers). GitHub omits private emails from {@code /user}, so the primary verified address is fetched
 * from {@code /user/emails}. The access token is used for these calls only and never stored.
 */
class ProviderUserService implements OAuth2UserService<OAuth2UserRequest, OAuth2User> {

    private final DefaultOAuth2UserService delegate = new DefaultOAuth2UserService();
    private final RestClient http = RestClient.create();

    @Override
    public OAuth2User loadUser(OAuth2UserRequest request) {
        OAuth2User user = delegate.loadUser(request);
        String provider = request.getClientRegistration().getRegistrationId();
        if (!"github".equals(provider) || user.getAttribute("email") != null) {
            return user;
        }
        Map<String, Object> attrs = new HashMap<>(user.getAttributes());
        String emailsUrl = request.getClientRegistration().getProviderDetails().getUserInfoEndpoint().getUri() + "/emails";
        try {
            List<Map<String, Object>> emails = http.get().uri(emailsUrl)
                    .header("Authorization", "Bearer " + request.getAccessToken().getTokenValue())
                    .header("Accept", "application/vnd.github+json")
                    .retrieve().body(new ParameterizedTypeReference<>() {});
            if (emails != null) {
                emails.stream()
                        .filter(e -> Boolean.TRUE.equals(e.get("primary")) && Boolean.TRUE.equals(e.get("verified")))
                        .findFirst()
                        .ifPresent(e -> {
                            attrs.put("email", e.get("email"));
                            attrs.put("email_verified", true);
                        });
            }
        } catch (RestClientException e) {
            throw new OAuth2AuthenticationException(new OAuth2Error("invalid_user_info_response", "emails lookup failed", null), e);
        }
        String nameKey = request.getClientRegistration().getProviderDetails().getUserInfoEndpoint().getUserNameAttributeName();
        return new DefaultOAuth2User(user.getAuthorities(), attrs, nameKey);
    }
}
