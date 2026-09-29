package com.example.chesswhisper.data.game;

import com.example.chesswhisper.data.game.model.GameHistoryResponse;
import com.example.chesswhisper.data.network.ApiClient;
import com.example.chesswhisper.data.network.ApiError;
import com.example.chesswhisper.data.network.ApiErrors;

import retrofit2.Call;
import retrofit2.Callback;
import retrofit2.Response;

// Wraps GameApi so the rest of the app never deals with Retrofit types directly.
// Same shape as UserRepository: an HTTP result becomes a success or an ApiError.
public class GameRepository {

    public interface HistoryCallback {
        void onSuccess(GameHistoryResponse response);
        void onError(ApiError error);
    }

    private final GameApi gameApi = ApiClient.getGameApi();

    public void history(HistoryCallback callback) {
        // No token handling here: ApiClient's interceptor attaches it, and its
        // authenticator has already tried refreshing before a 401 reaches us.
        gameApi.history().enqueue(new Callback<GameHistoryResponse>() {
            @Override
            public void onResponse(Call<GameHistoryResponse> call, Response<GameHistoryResponse> response) {
                if (response.isSuccessful() && response.body() != null) {
                    callback.onSuccess(response.body());
                } else {
                    callback.onError(ApiErrors.from(response));
                }
            }

            @Override
            public void onFailure(Call<GameHistoryResponse> call, Throwable t) {
                // No answer at all: server down, no network, timeout.
                callback.onError(ApiErrors.network());
            }
        });
    }
}
