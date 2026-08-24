package com.example.chesswhisper.data.user;

import com.example.chesswhisper.data.user.model.MeResponse;

import retrofit2.Call;
import retrofit2.http.GET;
import retrofit2.http.Header;

public interface UserApi {

    // No leading slash, so the path resolves relative to BASE_URL.
    // The header is passed explicitly rather than attached by an interceptor
    @GET("api/users/me")
    Call<MeResponse> me(@Header("Authorization") String bearer);
}
