package com.example.chesswhisper.data.auth;
import com.example.chesswhisper.data.auth.model.LoginRequest;
import com.example.chesswhisper.data.auth.model.LoginResponse;
import com.example.chesswhisper.data.auth.model.RefreshResponse;
import com.example.chesswhisper.data.auth.model.RefreshTokenRequest;
import com.example.chesswhisper.data.auth.model.RegisterRequest;
import com.example.chesswhisper.data.auth.model.RegisterResponse;

import retrofit2.Call;
import retrofit2.http.Body;
import retrofit2.http.POST;
// Retrofit builds the implementation of this interface at runtime (see ApiClient).
public interface AuthApi {

    // No leading slash, so the path resolves relative to BASE_URL.
    @POST("api/auth/register")
    // @Body makes Gson serialise the request object into the JSON body.
    // The Call is lazy: nothing hits the network until it is enqueued.
    Call<RegisterResponse> register(@Body RegisterRequest request);

    @POST("api/auth/login")
    Call<LoginResponse> login(@Body LoginRequest request);

    // Called both from AuthRepository (silent app-driven refresh, if ever
    // needed) and, synchronously via .execute(), from ApiClient's
    // Authenticator on a 401 — see ApiClient.buildOkHttpClient.
    @POST("api/auth/refresh")
    Call<RefreshResponse> refresh(@Body RefreshTokenRequest request);

    // Server always answers 204 regardless of whether the token was valid,
    // already revoked, or unknown — see server/src/rest/auth.routes.js.
    @POST("api/auth/logout")
    Call<Void> logout(@Body RefreshTokenRequest request);
}
