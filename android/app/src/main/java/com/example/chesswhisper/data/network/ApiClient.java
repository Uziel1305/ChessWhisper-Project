package com.example.chesswhisper.data.network;
import com.example.chesswhisper.BuildConfig;
import com.example.chesswhisper.data.auth.AuthApi;

import retrofit2.Retrofit;
import retrofit2.converter.gson.GsonConverterFactory;

// Builds and hands out the Retrofit-generated API interfaces. Shared plumbing:
// it knows nothing about auth, so UserApi and GameApi will be served from here too.
public final class ApiClient {

    // volatile is required for the double-checked locking below to be safe:
    // without it another thread could see a half-constructed object.
    private static volatile AuthApi authApi;

    // Private constructor — this is a static holder, never instantiated.
    private ApiClient(){}

    public static AuthApi getAuthApi(){
        // Built lazily on first use, then reused. Creating a Retrofit instance
        // per call would spin up a new connection pool and thread pool each time.
        if(authApi==null){
            synchronized (ApiClient.class){
                // Checked again inside the lock: another thread may have built it
                // while this one was waiting.
                if(authApi == null){
                    Retrofit retrofit= new Retrofit.Builder().
                            // BASE_URL is a build config value, so debug points at the
                            // emulator's host alias and release at the real server.
                            baseUrl(BuildConfig.BASE_URL)
                            // Gson handles JSON in both directions for every endpoint.
                            .addConverterFactory(GsonConverterFactory.create())
                            .build();
                    authApi=retrofit.create(AuthApi.class);
                }
            }

        }
        return authApi;
    }

    // CW-11 adds an OkHttpClient here, with an interceptor that attaches the
    // access token and an authenticator that refreshes it on a 401.
}
