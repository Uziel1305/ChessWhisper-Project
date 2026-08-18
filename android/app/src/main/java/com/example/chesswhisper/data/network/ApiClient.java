package com.example.chesswhisper.data.network;
import com.example.chesswhisper.BuildConfig;
import com.example.chesswhisper.data.auth.AuthApi;

import retrofit2.Retrofit;
import retrofit2.converter.gson.GsonConverterFactory;

public final class ApiClient {
    private static volatile AuthApi authApi;
    private ApiClient(){}

    public static AuthApi getAuthApi(){
        if(authApi==null){
            synchronized (ApiClient.class){
                if(authApi == null){
                    Retrofit retrofit= new Retrofit.Builder().
                            baseUrl(BuildConfig.BASE_URL)
                            .addConverterFactory(GsonConverterFactory.create())
                            .build();
                    authApi=retrofit.create(AuthApi.class);
                }
            }

        }
        return authApi;
    }

}
