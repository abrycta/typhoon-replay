package dev.krtmtthw.typhoon.accounts.internal;

import java.net.URI;
import java.sql.Array;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import dev.krtmtthw.typhoon.contract.model.Provider;
import dev.krtmtthw.typhoon.contract.model.User;
import dev.krtmtthw.typhoon.shared.catalog.CatalogRows;

/** {@code auth.app_user} and {@code auth.oauth_account}: one account per provider identity, never linked by email. */
@Repository
public class UserAccounts {

    private final JdbcClient jdbc;

    public UserAccounts(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /** What a provider's userinfo told us; upserted on every sign-in. */
    public record Identity(String provider, String subject, String email, boolean emailVerified, String displayName,
            String avatarUrl) {}

    @Transactional
    public UUID upsert(Identity id) {
        String name = displayName(id);
        Optional<UUID> existing = jdbc.sql("""
                UPDATE auth.oauth_account SET email = :email, email_verified = :verified, last_login_at = now()
                WHERE provider = :provider AND subject = :subject RETURNING user_id""")
                .param("email", id.email()).param("verified", id.emailVerified())
                .param("provider", id.provider()).param("subject", id.subject())
                .query(UUID.class).optional();
        if (existing.isPresent()) {
            jdbc.sql("""
                    UPDATE auth.app_user SET display_name = :name, email = coalesce(:email, email),
                           email_verified = :verified, avatar_url = coalesce(:avatar, avatar_url), updated_at = now()
                    WHERE id = :id""")
                    .param("name", name).param("email", id.email()).param("verified", id.emailVerified())
                    .param("avatar", id.avatarUrl()).param("id", existing.get()).update();
            return existing.get();
        }
        UUID user = jdbc.sql("""
                INSERT INTO auth.app_user (display_name, email, email_verified, avatar_url)
                VALUES (:name, :email, :verified, :avatar) RETURNING id""")
                .param("name", name).param("email", id.email()).param("verified", id.emailVerified())
                .param("avatar", id.avatarUrl()).query(UUID.class).single();
        jdbc.sql("""
                INSERT INTO auth.oauth_account (provider, subject, user_id, email, email_verified)
                VALUES (:provider, :subject, :user, :email, :verified)""")
                .param("provider", id.provider()).param("subject", id.subject()).param("user", user)
                .param("email", id.email()).param("verified", id.emailVerified()).update();
        return user;
    }

    public Optional<User> find(UUID userId) {
        return jdbc.sql("""
                SELECT u.id, u.display_name, u.email, u.avatar_url, u.locale, u.created_at,
                       array(SELECT o.provider FROM auth.oauth_account o WHERE o.user_id = u.id ORDER BY o.created_at, o.provider) AS providers
                FROM auth.app_user u WHERE u.id = :id""").param("id", userId).query((rs, n) -> {
            List<Provider> providers = new ArrayList<>();
            Array arr = rs.getArray("providers");
            for (Object p : (Object[]) arr.getArray()) {
                providers.add(Provider.fromValue(p.toString()));
            }
            User u = new User(rs.getObject("id", UUID.class), rs.getString("display_name"), providers,
                    CatalogRows.timestamp(rs, "created_at"));
            u.setEmail(rs.getString("email"));
            String avatar = rs.getString("avatar_url");
            if (avatar != null) {
                try {
                    u.setAvatarUrl(URI.create(avatar));
                } catch (IllegalArgumentException ignored) {
                    // not a URI: omit rather than fail
                }
            }
            String locale = rs.getString("locale");
            u.setLocale(locale == null ? null : User.LocaleEnum.fromValue(locale));
            return u;
        }).optional();
    }

    /** Deletes the user; identities, sessions, saved places and alert data cascade. */
    public void delete(UUID userId) {
        jdbc.sql("DELETE FROM auth.app_user WHERE id = :id").param("id", userId).update();
    }

    private static String displayName(Identity id) {
        String name = id.displayName();
        if (name == null || name.isBlank()) {
            name = id.email() != null ? id.email().replaceAll("@.*", "") : id.provider() + " user";
        }
        name = name.strip();
        return name.length() > 200 ? name.substring(0, 200) : name;
    }
}
