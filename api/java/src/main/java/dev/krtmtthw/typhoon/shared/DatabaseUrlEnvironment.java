package dev.krtmtthw.typhoon.shared;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

import org.springframework.boot.EnvironmentPostProcessor;
import org.springframework.boot.SpringApplication;
import org.springframework.core.Ordered;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;

/**
 * Turns the shared {@code DATABASE_URL} ({@code postgres://user:pass@host:port/db?sslmode=require}, the form Neon,
 * Render and compose use) into Spring's JDBC datasource properties. Server-side prepared statements are disabled
 * ({@code prepareThreshold=0}) because the Neon pooler runs PgBouncer in transaction mode (CONTRACT-GUIDE §11).
 */
public class DatabaseUrlEnvironment implements EnvironmentPostProcessor, Ordered {

    @Override
    public void postProcessEnvironment(ConfigurableEnvironment env, SpringApplication application) {
        String url = env.getProperty("DATABASE_URL");
        if (url == null || url.isBlank()) {
            if (env.containsProperty("SPRING_DATASOURCE_URL")) {
                return; // explicit JDBC settings (tests) win
            }
            url = "postgres://tr:tr@localhost:5432/typhoon?sslmode=disable"; // compose default (just db-up)
        }
        env.getPropertySources().addFirst(new MapPropertySource("databaseUrl", toSpring(url)));
    }

    static Map<String, Object> toSpring(String databaseUrl) {
        URI uri = URI.create(databaseUrl.trim());
        if (!"postgres".equals(uri.getScheme()) && !"postgresql".equals(uri.getScheme())) {
            throw new IllegalArgumentException("DATABASE_URL must be a postgres:// URL");
        }
        Map<String, String> params = new LinkedHashMap<>();
        if (uri.getRawQuery() != null) {
            for (String pair : uri.getRawQuery().split("&")) {
                int eq = pair.indexOf('=');
                String key = decode(eq < 0 ? pair : pair.substring(0, eq));
                String value = eq < 0 ? "" : decode(pair.substring(eq + 1));
                switch (key) {
                    case "sslmode", "sslrootcert" -> params.put(key, value);
                    case "channel_binding" -> params.put("channelBinding", value);
                    default -> { /* libpq-only options are dropped */ }
                }
            }
        }
        params.putIfAbsent("prepareThreshold", "0");
        params.putIfAbsent("ApplicationName", "typhoon-replay-java");
        StringBuilder jdbc = new StringBuilder("jdbc:postgresql://").append(uri.getHost());
        if (uri.getPort() > 0) {
            jdbc.append(':').append(uri.getPort());
        }
        jdbc.append(uri.getRawPath() == null || uri.getRawPath().isEmpty() ? "/" : uri.getRawPath());
        String sep = "?";
        for (var e : params.entrySet()) {
            jdbc.append(sep).append(e.getKey()).append('=').append(e.getValue());
            sep = "&";
        }
        Map<String, Object> props = new LinkedHashMap<>();
        props.put("spring.datasource.url", jdbc.toString());
        String userInfo = uri.getRawUserInfo();
        if (userInfo != null) {
            int colon = userInfo.indexOf(':');
            props.put("spring.datasource.username", decode(colon < 0 ? userInfo : userInfo.substring(0, colon)));
            if (colon >= 0) {
                props.put("spring.datasource.password", decode(userInfo.substring(colon + 1)));
            }
        }
        return props;
    }

    private static String decode(String s) {
        // Percent-decoding only: a literal '+' in a password is a plus, not a space.
        return URLDecoder.decode(s.replace("+", "%2B"), StandardCharsets.UTF_8);
    }

    @Override
    public int getOrder() {
        return Ordered.LOWEST_PRECEDENCE;
    }
}
