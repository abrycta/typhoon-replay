package dev.krtmtthw.typhoon.accounts.web;

import java.net.URI;
import java.util.UUID;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RestController;

import dev.krtmtthw.typhoon.accounts.CurrentUser;
import dev.krtmtthw.typhoon.accounts.SavedPlaces;
import dev.krtmtthw.typhoon.accounts.internal.SessionCookie;
import dev.krtmtthw.typhoon.accounts.internal.UserAccounts;
import dev.krtmtthw.typhoon.contract.api.MeApi;
import dev.krtmtthw.typhoon.contract.model.SavedPlace;
import dev.krtmtthw.typhoon.contract.model.SavedPlaceCreate;
import dev.krtmtthw.typhoon.contract.model.SavedPlaceList;
import dev.krtmtthw.typhoon.contract.model.SavedPlaceUpdate;
import dev.krtmtthw.typhoon.contract.model.User;
import dev.krtmtthw.typhoon.shared.problem.ApiException;
import dev.krtmtthw.typhoon.shared.web.Paging;

/** The signed-in user and saved places (tag {@code me}). {@code Cache-Control: private, no-store; Vary: Cookie}. */
@RestController
class MeController implements MeApi {

    private final UserAccounts users;
    private final SavedPlaces saved;
    private final Paging paging;
    private final HttpServletRequest request;
    private final HttpServletResponse response;

    MeController(UserAccounts users, SavedPlaces saved, Paging paging, HttpServletRequest request,
            HttpServletResponse response) {
        this.users = users;
        this.saved = saved;
        this.paging = paging;
        this.request = request;
        this.response = response;
    }

    @Override
    public ResponseEntity<User> getMe() {
        UUID id = CurrentUser.id();
        return ResponseEntity.ok(users.find(id).orElseThrow(() -> new ApiException(
                dev.krtmtthw.typhoon.shared.problem.ProblemType.UNAUTHENTICATED, "Sign in first.")));
    }

    @Override
    public ResponseEntity<Void> deleteMe() {
        users.delete(CurrentUser.id());
        SessionCookie.clear(response);
        return ResponseEntity.noContent().build();
    }

    @Override
    public ResponseEntity<SavedPlaceList> listSavedPlaces() {
        return ResponseEntity.ok(new SavedPlaceList(saved.list(CurrentUser.id())));
    }

    @Override
    public ResponseEntity<SavedPlace> createSavedPlace(SavedPlaceCreate body) {
        SavedPlace created = saved.create(CurrentUser.id(), body.getPlaceId(), body.getPosition(), body.getLabel());
        URI location = URI.create(paging.publicBase(request) + "/v1/me/places/" + created.getId());
        return ResponseEntity.created(location).body(created);
    }

    @Override
    public ResponseEntity<SavedPlace> updateSavedPlace(UUID savedPlaceId, SavedPlaceUpdate body) {
        return ResponseEntity.ok(saved.rename(CurrentUser.id(), savedPlaceId, body.getLabel())
                .orElseThrow(() -> ApiException.notFound("No such saved place.")));
    }

    @Override
    public ResponseEntity<Void> deleteSavedPlace(UUID savedPlaceId) {
        if (!saved.delete(CurrentUser.id(), savedPlaceId)) {
            throw ApiException.notFound("No such saved place.");
        }
        return ResponseEntity.noContent().build();
    }
}
