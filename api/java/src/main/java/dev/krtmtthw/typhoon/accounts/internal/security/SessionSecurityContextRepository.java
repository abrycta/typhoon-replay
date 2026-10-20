package dev.krtmtthw.typhoon.accounts.internal.security;

import java.util.function.Supplier;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.security.core.context.DeferredSecurityContext;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.context.HttpRequestResponseHolder;
import org.springframework.security.web.context.SecurityContextRepository;

import dev.krtmtthw.typhoon.accounts.internal.SessionCookie;
import dev.krtmtthw.typhoon.accounts.internal.SessionStore;

/**
 * Spring Security's view of the shared {@code auth.session} table. The context is loaded lazily, so only requests
 * that need a user (the {@code /v1/me} operations) look the cookie up. Saving is a no-op: sessions are minted
 * explicitly by the OAuth success handler and the test hook, never from a {@code SecurityContext}.
 */
class SessionSecurityContextRepository implements SecurityContextRepository {

    private final SessionStore sessions;

    SessionSecurityContextRepository(SessionStore sessions) {
        this.sessions = sessions;
    }

    @Override
    public DeferredSecurityContext loadDeferredContext(HttpServletRequest request) {
        Supplier<SecurityContext> load = () -> {
            SecurityContext context = SecurityContextHolder.createEmptyContext();
            sessions.find(SessionCookie.read(request))
                    .ifPresent(s -> context.setAuthentication(new SessionAuthentication(s.userId())));
            return context;
        };
        return new DeferredSecurityContext() {
            private SecurityContext context;

            @Override
            public synchronized SecurityContext get() {
                if (context == null) {
                    context = load.get();
                }
                return context;
            }

            @Override
            public boolean isGenerated() {
                return get().getAuthentication() == null;
            }
        };
    }

    @Override
    @Deprecated
    public SecurityContext loadContext(HttpRequestResponseHolder holder) {
        return loadDeferredContext(holder.getRequest()).get();
    }

    @Override
    public void saveContext(SecurityContext context, HttpServletRequest request, HttpServletResponse response) {
        // Sessions are created explicitly (SessionStore.create), not from the security context.
    }

    @Override
    public boolean containsContext(HttpServletRequest request) {
        return SessionCookie.read(request) != null;
    }
}
