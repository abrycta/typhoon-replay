package dev.krtmtthw.typhoon.accounts.internal;

import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseCookie;

/** {@code __Host-tr_session=<token>; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000} (CONTRACT-GUIDE §9). */
public final class SessionCookie {

    public static final String NAME = "__Host-tr_session";

    private SessionCookie() {}

    public static String read(HttpServletRequest request) {
        Cookie[] cookies = request.getCookies();
        if (cookies != null) {
            for (Cookie c : cookies) {
                if (NAME.equals(c.getName())) {
                    return c.getValue();
                }
            }
        }
        return null;
    }

    public static void set(HttpServletResponse response, String token) {
        response.addHeader(HttpHeaders.SET_COOKIE, cookie(token, SessionStore.TTL.toSeconds()));
    }

    /** Same attributes, empty value, {@code Max-Age=0}. */
    public static void clear(HttpServletResponse response) {
        response.addHeader(HttpHeaders.SET_COOKIE, cookie("", 0));
    }

    public static String cookie(String value, long maxAgeSeconds) {
        return ResponseCookie.from(NAME, value).path("/").secure(true).httpOnly(true).sameSite("Lax")
                .maxAge(maxAgeSeconds).build().toString();
    }
}
