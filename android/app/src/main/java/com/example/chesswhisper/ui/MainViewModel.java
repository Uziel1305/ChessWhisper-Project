package com.example.chesswhisper.ui;

import androidx.annotation.NonNull;
import androidx.lifecycle.LiveData;
import androidx.lifecycle.MutableLiveData;
import androidx.lifecycle.ViewModel;
import com.example.chesswhisper.data.network.ApiError;
import com.example.chesswhisper.data.auth.AuthRepository;
import com.example.chesswhisper.data.auth.model.LoginResponse;

// Holds the login screen's state — same shape as RegisterViewModel, since
// MainActivity is the login screen (see CLAUDE.md's "MainActivity is the login
// screen" decision). Being a ViewModel, it survives rotation, so an in-flight
// login is not restarted and its result is not lost.
public class MainViewModel extends ViewModel {

    public enum Status {IDLE, LOADING, SUCCESS, ERROR}

    // Immutable snapshot of the screen. One object means status and error can
    // never disagree, unlike two separate LiveData fields.
    public static final class LoginState {
        public final Status status;
        public final ApiError error;

        // Package-private: only this ViewModel is allowed to produce a state.
        LoginState(Status status, ApiError error) {
            this.status = status;
            this.error = error;
        }
    }

    private final AuthRepository authRepository = new AuthRepository();

    // Mutable internally, exposed read-only below so the Activity can observe
    // but never write.
    private final MutableLiveData<LoginState> state = new MutableLiveData<>(new LoginState(Status.IDLE, null));

    public LiveData<LoginState> getState() {
        return state;
    }

    public void login(@NonNull String username, @NonNull String password) {
        // Flip to LOADING first so the UI shows the spinner and disables the
        // button before the request goes out.
        state.setValue(new LoginState(Status.LOADING, null));
        authRepository.login(username, password, new AuthRepository.LoginCallback() {
            @Override
            public void onSuccess(LoginResponse response) {
                // The repository already persisted the session by the time this
                // fires — the Activity's job on SUCCESS is only to navigate.
                state.setValue(new LoginState(Status.SUCCESS, null));
            }

            @Override
            public void onError(ApiError error) {
                state.setValue(new LoginState(Status.ERROR, error));
            }
        });
    }
}
