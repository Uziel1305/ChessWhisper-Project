package com.example.chesswhisper.data.user;

import com.example.chesswhisper.data.user.model.MeResponse;

import retrofit2.Call;
import retrofit2.http.GET;

// Retrofit builds the implementation of this interface at runtime (see ApiClient).
public interface UserApi {

    // No leading slash, so the path resolves relative to BASE_URL.
    // No Authorization parameter: ApiClient's interceptor attaches the access
    // token to every outgoing request, so no screen or repository handles it.
    @GET("api/users/me")
    Call<MeResponse> me();
}