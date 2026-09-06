package com.example.chesswhisper.data.network;
import com.example.chesswhisper.BuildConfig;
import com.example.chesswhisper.data.auth.AuthApi;
import com.example.chesswhisper.data.user.UserApi;
import com.example.chesswhisper.data.auth.SessionManager;
import com.example.chesswhisper.data.auth.model.RefreshResponse;
import com.example.chesswhisper.data.auth.model.RefreshTokenRequest;

import java.io.IOException;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.Route;
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
    private static volatile OkHttpClient httpClient;

    // Private constructor — this is a static holder, never instantiated.
    private ApiClient(){}

      // The single place the Retrofit instance is built, so every API shares one
    // connection pool, one thread pool, and one auth interceptor.
    private static Retrofit getRetrofit(){
        if(retrofit == null){
            synchronized (ApiClient.class){
                if(retrofit == null){
                    retrofit = new Retrofit.Builder()
                            // BASE_URL is a build config value, so debug points at the
                            // emulator's host alias and release at the real server.
                            .baseUrl(BuildConfig.BASE_URL)
                            // Gson handles JSON in both directions for every endpoint.
                            .addConverterFactory(GsonConverterFactory.create())
                            .client(getHttpClient())
                            .build();
                }
            }
        }
        return retrofit;
    }

    // Shared with GameSocket's WebSocket handshake, so the Authorization header is
    // still written in exactly one place (the interceptor below) rather than a
    // second copy of this logic living next to the WS client.
    public static OkHttpClient getHttpClient() {
        if (httpClient == null) {
            synchronized (ApiClient.class) {
                if (httpClient == null) {
                    // Retrofit creates a default OkHttpClient internally: up to 64 concurrent
                    // requests (5 per host), worker threads created on demand, and a pool holding
                    // 5 idle connections for about 5 minutes.
                    // An explicit OkHttpClient rather than Retrofit's default,
                    // so every call through every API gets the auth interceptor
                    // and the refresh-on-401 authenticator below.
                    httpClient = buildOkHttpClient();
                }
            }
        }
        return httpClient;
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


    private static OkHttpClient buildOkHttpClient() {
        return new OkHttpClient.Builder()
                // Attaches the stored access token to every outgoing call. Doing
                // this unconditionally (including on /login, /register, /refresh)
                // is harmless — none of those routes read Authorization — and it
                // avoids maintaining a path-exclusion list here.
                .addInterceptor(chain -> {
                    Request original = chain.request();
                    String accessToken = SessionManager.getInstance().getAccessToken();
                    if (accessToken == null) {
                        return chain.proceed(original);
                    }
                    Request authed = original.newBuilder()
                            .header("Authorization", "Bearer " + accessToken)
                            .build();
                    return chain.proceed(authed);
                })
                // Runs automatically when a response comes back 401. Refreshes
                // the access token once and retries. If the refresh itself fails
                // the session is cleared and the caller sees the original 401 —
                // which is what sends SessionAwareActivity back to the login screen.
                .authenticator((route, response) -> {
                    // Never try to "fix" a 401 from the auth endpoints themselves
                    // by calling /refresh: on /refresh that's the reuse-detection
                    // trap (a dead token 401s, this fires, calls /refresh again
                    // with the same dead token via a brand-new .execute() call
                    // that has its own fresh follow-up budget and prior-response
                    // chain, so responseCount below never trips — unbounded
                    // recursion). On /login it would just waste a round trip
                    // retrying what's really an invalid_credentials 401.
                    String path = response.request().url().encodedPath();
                    if (path.startsWith("/api/auth/")) {
                        return null;
                    }
                    if (responseCount(response) > 1) {
                        // Already retried once with a freshly refreshed token and
                        // still got a 401 — refreshing again would loop forever.
                        return null;
                    }
                    String refreshToken = SessionManager.getInstance().getRefreshToken();
                    if (refreshToken == null) {
                        return null;
                    }
                    try {
                        retrofit2.Response<RefreshResponse> refreshed = getAuthApi()
                                .refresh(new RefreshTokenRequest(refreshToken))
                                // Authenticator runs on OkHttp's own thread and must
                                // block — enqueue() would return before this could
                                // use the result.
                                .execute();
                        if (!refreshed.isSuccessful() || refreshed.body() == null) {
                            // Refresh token invalid/expired/reused — the session is
                            // dead, so there is nothing left worth keeping locally.
                            SessionManager.getInstance().clearSession();
                            return null;
                        }
                        RefreshResponse body = refreshed.body();
                        SessionManager.getInstance().saveSession(
                                body.getAccessToken(), body.getRefreshToken(), SessionManager.getInstance().getUserId());
                        return response.request().newBuilder()
                                .header("Authorization", "Bearer " + body.getAccessToken())
                                .build();
                    } catch (IOException e) {
                        // Refresh call itself couldn't reach the server — give up on
                        // this request rather than retrying indefinitely.
                        return null;
                    }
                })
                .build();
    }

    // Standard OkHttp recipe for counting prior attempts on the same request
    // chain, so the Authenticator above can bail out instead of looping.
    private static int responseCount(Response response) {
        int result = 1;
        while ((response = response.priorResponse()) != null) {
            result++;
        }
        return result;
    }
}
