package com.example.chesswhisper.data.auth;
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

    // login(), refresh() and logout() get added here in CW-11.
}
