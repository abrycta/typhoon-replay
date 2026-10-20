package dev.krtmtthw.typhoon.accounts.internal.security;

import java.util.List;
import java.util.UUID;

import org.springframework.security.authentication.AbstractAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;

/** An authenticated request: the user behind a valid {@code __Host-tr_session} cookie. */
public final class SessionAuthentication extends AbstractAuthenticationToken {

    private final UUID userId;

    public SessionAuthentication(UUID userId) {
        super(List.of(new SimpleGrantedAuthority("ROLE_USER")));
        this.userId = userId;
        setAuthenticated(true);
    }

    public UUID userId() {
        return userId;
    }

    @Override
    public Object getCredentials() {
        return "";
    }

    @Override
    public Object getPrincipal() {
        return userId;
    }
}
