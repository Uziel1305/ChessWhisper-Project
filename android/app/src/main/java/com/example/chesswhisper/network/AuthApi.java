package com.example.chesswhisper.network;
import retrofit2.Call;
import retrofit2.http.Body;
import retrofit2.http.POST;
public interface AuthApi {
    @POST("api/auth/register")
    Call<RegisterResponse> register(@Body RegisterRequest request);
}
