package com.example.chesswhisper.data.auth;
import com.example.chesswhisper.data.network.ApiClient;
import com.example.chesswhisper.data.network.ApiError;
import com.example.chesswhisper.data.auth.model.LoginRequest;
import com.example.chesswhisper.data.auth.model.LoginResponse;
import com.example.chesswhisper.data.auth.model.RefreshResponse;
import com.example.chesswhisper.data.auth.model.RefreshTokenRequest;
import com.example.chesswhisper.data.auth.model.RegisterRequest;
import com.example.chesswhisper.data.auth.model.RegisterResponse;
import com.google.gson.Gson;
import java.io.IOException;
import retrofit2.Call;
import retrofit2.Callback;
import retrofit2.Response;


// Wraps AuthApi so the rest of the app never deals with Retrofit types directly.
// Its job is to turn an HTTP result into either a success or an ApiError.
public class AuthRepository {

    // Two outcomes only, so the ViewModel never has to inspect status codes.
    public interface RegisterCallback{
        void onSuccess(RegisterResponse response);
        void onError(ApiError error);
    }

    public interface LoginCallback {
        void onSuccess(LoginResponse response);
        void onError(ApiError error);
    }

    public interface LogoutCallback {
        void onComplete();
    }

    // Used only by MainActivity's CW-18 startup check. Three outcomes, not
    // two: a confirmed-dead session (server said no) must clear local storage,
    // but a network failure must not — the token might still be good, and the
    // user shouldn't be forced to re-login just because they had no signal.
    public interface RefreshCallback {
        void onSuccess();
        void onSessionExpired();
        void onNetworkError();
    }

    private final AuthApi authApi= ApiClient.getAuthApi();

    public void register(String username, String password, RegisterCallback callback){
        RegisterRequest request= new RegisterRequest(username, password);
        Call<RegisterResponse> call=authApi.register(request);
        Callback<RegisterResponse> callback2=new Callback<RegisterResponse>() {

            // Reached whenever the server answered at all — including 400 and 409.
            // "The request completed" is not the same as "it succeeded".
            @Override
            public void onResponse(Call<RegisterResponse> call, Response<RegisterResponse> response) {
                if(response.isSuccessful() && response.body()!=null){
                    callback.onSuccess(response.body());
                }else{
                    // 400 validation_error / 409 username_taken land here.
                    callback.onError(parseError(response));
                }
            }

            // Reached only when the request never got an answer: server down, no
            // network, timeout. There is no error body to read, so we build our own.
            @Override
            public void onFailure(Call<RegisterResponse> call, Throwable t) {
                callback.onError(new ApiError("network_error", "Unable to reach server. Check your connection."));
            }
        };
        // enqueue runs the call on a background thread and delivers both callbacks
        // back on the main thread, which is why the ViewModel can use setValue.
        call.enqueue(callback2);
    }

    public void login(String username, String password, LoginCallback callback) {
        LoginRequest request = new LoginRequest(username, password);
        authApi.login(request).enqueue(new Callback<LoginResponse>() {
            @Override
            public void onResponse(Call<LoginResponse> call, Response<LoginResponse> response) {
                if (response.isSuccessful() && response.body() != null) {
                    LoginResponse body = response.body();
                    // Persisted here, not in the ViewModel — the ViewModel should
                    // know as little about storage as it does about HTTP.
                    SessionManager.getInstance().saveSession(
                            body.getAccessToken(), body.getRefreshToken(), body.getUserId());
                    callback.onSuccess(body);
                } else {
                    // 400 validation_error / 401 invalid_credentials land here.
                    callback.onError(parseError(response));
                }
            }

            @Override
            public void onFailure(Call<LoginResponse> call, Throwable t) {
                callback.onError(new ApiError("network_error", "Unable to reach server. Check your connection."));
            }
        });
    }

    // CW-18: called once at app startup when a refresh token is already stored,
    // to confirm server-side that it's still good before trusting it — rather
    // than just trusting whatever is sitting in local storage.
    public void refreshSession(RefreshCallback callback) {
        String refreshToken = SessionManager.getInstance().getRefreshToken();
        if (refreshToken == null) {
            callback.onSessionExpired();
            return;
        }
        authApi.refresh(new RefreshTokenRequest(refreshToken)).enqueue(new Callback<RefreshResponse>() {
            @Override
            public void onResponse(Call<RefreshResponse> call, Response<RefreshResponse> response) {
                if (response.isSuccessful() && response.body() != null) {
                    RefreshResponse body = response.body();
                    SessionManager.getInstance().saveSession(
                            body.getAccessToken(), body.getRefreshToken(), SessionManager.getInstance().getUserId());
                    callback.onSuccess();
                } else {
                    // 401 invalid_refresh_token / refresh_token_expired /
                    // refresh_token_reused — the server has confirmed this
                    // session is dead, so there is nothing left worth keeping.
                    SessionManager.getInstance().clearSession();
                    callback.onSessionExpired();
                }
            }

            @Override
            public void onFailure(Call<RefreshResponse> call, Throwable t) {
                // Couldn't reach the server at all — deliberately NOT clearing
                // the session here, unlike the 401 branch above.
                callback.onNetworkError();
            }
        });
    }

    // Used by LogoutButton-style callers, if/when one exists. Clears the local
    // session regardless of how the server call goes — an offline user still
    // expects to be logged out on this device.
    public void logout(LogoutCallback callback) {
        String refreshToken = SessionManager.getInstance().getRefreshToken();
        SessionManager.getInstance().clearSession();
        if (refreshToken == null) {
            callback.onComplete();
            return;
        }
        authApi.logout(new RefreshTokenRequest(refreshToken)).enqueue(new Callback<Void>() {
            @Override
            public void onResponse(Call<Void> call, Response<Void> response) {
                callback.onComplete();
            }

            @Override
            public void onFailure(Call<Void> call, Throwable t) {
                // Local session is already cleared; the server-side revoke not
                // landing just means that refresh token dies of natural expiry.
                callback.onComplete();
            }
        });
    }

    // Turns the server's JSON error body into an ApiError the UI can display.
    // Generic over the response's body type so both register's and login's
    // Response<T> can share this without duplicating the parsing logic.
    private <T> ApiError parseError(Response<T> response) {
        try {
            if (response.errorBody() != null) {
                return new Gson().fromJson(response.errorBody().string(), ApiError.class);
            }
        } catch (IOException e) {
            // fall through
        }
        // Fallback for an unreadable or missing body — the user still gets
        // something sensible rather than a blank error line.
        return new ApiError("unknown_error", "Something went wrong. Please try again.");
    }

}
