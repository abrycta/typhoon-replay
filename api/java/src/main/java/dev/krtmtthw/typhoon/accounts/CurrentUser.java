package dev.krtmtthw.typhoon.accounts;

import java.util.UUID;

import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

import dev.krtmtthw.typhoon.accounts.internal.security.SessionAuthentication;
import dev.krtmtthw.typhoon.shared.problem.ApiException;
import dev.krtmtthw.typhoon.shared.problem.ProblemType;

/** The accounts module's API for "who is calling": the user of the current request's session. */
public final class CurrentUser {

    private CurrentUser() {}

    /** The signed-in user's id, or 401 {@code unauthenticated}. */
    public static UUID id() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth instanceof SessionAuthentication session) {
            return session.userId();
        }
        throw new ApiException(ProblemType.UNAUTHENTICATED, "Sign in first.");
    }
}
