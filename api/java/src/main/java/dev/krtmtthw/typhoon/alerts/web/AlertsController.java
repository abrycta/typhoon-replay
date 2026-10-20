package dev.krtmtthw.typhoon.alerts.web;

import java.util.UUID;

import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RestController;

import dev.krtmtthw.typhoon.accounts.CurrentUser;
import dev.krtmtthw.typhoon.accounts.SavedPlaces;
import dev.krtmtthw.typhoon.alerts.internal.AlertSubscriptions;
import dev.krtmtthw.typhoon.contract.api.AlertsApi;
import dev.krtmtthw.typhoon.contract.model.AlertPreferences;
import dev.krtmtthw.typhoon.contract.model.AlertPreferencesUpdate;
import dev.krtmtthw.typhoon.shared.problem.ApiException;

/** Alert preferences and one-click unsubscribe (tag {@code alerts}). */
@RestController
class AlertsController implements AlertsApi {

    private static final MediaType HTML = new MediaType(MediaType.TEXT_HTML, java.nio.charset.StandardCharsets.UTF_8);
    private static final String UNSUBSCRIBED = "<!doctype html><meta charset=\"utf-8\"><title>Unsubscribed</title>"
            + "<p>You will no longer receive Typhoon Replay alerts.</p>";

    private final AlertSubscriptions subscriptions;
    private final SavedPlaces savedPlaces;

    AlertsController(AlertSubscriptions subscriptions, SavedPlaces savedPlaces) {
        this.subscriptions = subscriptions;
        this.savedPlaces = savedPlaces;
    }

    @Override
    public ResponseEntity<AlertPreferences> getAlertPreferences() {
        return ResponseEntity.ok(subscriptions.read(CurrentUser.id()));
    }

    @Override
    public ResponseEntity<AlertPreferences> replaceAlertPreferences(AlertPreferencesUpdate body) {
        UUID user = CurrentUser.id();
        if (!savedPlaces.allOwnedBy(user, body.getSavedPlaceIds())) {
            throw ApiException.unprocessable("savedPlaceIds must be your own saved places.");
        }
        String language = body.getLanguage() == null ? "en" : body.getLanguage().getValue();
        subscriptions.replace(user, body.getEnabled(), body.getRadiusKm().getValue(), body.getMinWindKt(), language,
                body.getSavedPlaceIds());
        return ResponseEntity.ok(subscriptions.read(user));
    }

    @Override
    public ResponseEntity<String> unsubscribeAlerts(String token) {
        if (!subscriptions.unsubscribe(token)) {
            throw ApiException.notFound("Unknown unsubscribe token.");
        }
        return ResponseEntity.ok().contentType(HTML).body(UNSUBSCRIBED);
    }
}
