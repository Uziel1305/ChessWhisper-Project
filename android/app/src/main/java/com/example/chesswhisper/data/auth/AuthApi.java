package com.example.chesswhisper.data.auth;
import com.example.chesswhisper.data.auth.model.RegisterRequest;
import com.example.chesswhisper.data.auth.model.RegisterResponse;

import retrofit2.Call;
import retrofit2.http.Body;
import retrofit2.http.POST;
public interface AuthApi {
    @POST("api/auth/register")
    Call<RegisterResponse> register(@Body RegisterRequest request);
}
