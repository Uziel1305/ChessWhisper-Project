package com.example.chesswhisper.data.game;

import com.example.chesswhisper.data.game.model.GameHistoryResponse;

import retrofit2.Call;
import retrofit2.http.GET;

// Retrofit builds the implementation of this interface at runtime (see ApiClient).
// REST only — everything in-game goes over GameSocket instead.
public interface GameApi {

    // The caller's own finished games, newest first, plus their total. No user id
    // anywhere in the request: the server reads it from the access token, which
    // ApiClient's interceptor attaches.
    @GET("api/games/history")
    Call<GameHistoryResponse> history();
}
