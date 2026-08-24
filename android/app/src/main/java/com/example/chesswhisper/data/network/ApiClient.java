package com.example.chesswhisper.data.network;
import com.example.chesswhisper.BuildConfig;
import com.example.chesswhisper.data.auth.AuthApi;
import com.example.chesswhisper.data.user.UserApi;

import retrofit2.Retrofit;
import retrofit2.converter.gson.GsonConverterFactory;

// Builds and hands out the Retrofit-generated API interfaces. Shared plumbing:
// it knows nothing about auth, so UserApi and GameApi will be served from here too.
public final class ApiClient {

    // volatile is required for the double-checked locking below to be safe:
    // without it another thread could see a half-constructed object.
    private static volatile Retrofit retrofit;
    private static volatile AuthApi authApi;
    private static volatile UserApi userApi;

    // Private constructor — this is a static holder, never instantiated.
    private ApiClient(){}




    // The single place the Retrofit instance is built, so every API shares one
    // connection pool and one thread pool. CW-11's OkHttpClient plugs in here
    // once — with the interceptor that attaches the access token and the
    // authenticator that refreshes it on a 401 — and every API gets it at once.
    private static Retrofit getRetrofit(){
        if(retrofit == null){
            synchronized (ApiClient.class){
                if(retrofit == null){
                    // Retrofit creates a default OkHttpClient internally: up to 64 concurrent
                    // requests (5 per host), worker threads created on demand, and a pool holding
                    // 5 idle connections for about 5 minutes. CW-11 replaces it with an explicit
                    // client so an interceptor can attach the access token.
                    retrofit = new Retrofit.Builder()
                            // BASE_URL is a build config value, so debug points at the
                            // emulator's host alias and release at the real server.
                            .baseUrl(BuildConfig.BASE_URL)
                            // Gson handles JSON in both directions for every endpoint.
                            .addConverterFactory(GsonConverterFactory.create())
                            .build();
                }
            }
        }
        return retrofit;
    }


    public static AuthApi getAuthApi(){
        // Built lazily on first use, then reused. Creating a Retrofit instance
        // per call would spin up a new connection pool and thread pool each time.
        if(authApi==null){
            synchronized (ApiClient.class){
                // Checked again inside the lock: another thread may have built it
                // while this one was waiting.
                if(authApi == null){
                    authApi=getRetrofit().create(AuthApi.class);
                }
            }

        }
        return authApi;
    }

    public static UserApi getUserApi(){
        if(userApi == null){
            synchronized (ApiClient.class){
                if(userApi == null){
                    userApi = getRetrofit().create(UserApi.class);
                }
            }
        }
        return userApi;
    }


}
