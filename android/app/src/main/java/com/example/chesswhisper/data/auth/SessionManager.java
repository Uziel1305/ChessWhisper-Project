package com.example.chesswhisper.data.auth;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import java.io.IOException;
import java.security.GeneralSecurityException;

// Holds the two tokens from a login/refresh, encrypted at rest. Android never
// validates or decodes either token — this class only stores and returns
// strings, per the "stay logged in" design in CLAUDE.md.
public final class SessionManager {

    private static final String PREFS_FILE = "session";
    private static final String KEY_ACCESS_TOKEN = "access_token";
    private static final String KEY_REFRESH_TOKEN = "refresh_token";
    private static final String KEY_USER_ID = "user_id";

    // volatile for the same reason as ApiClient.authApi: double-checked locking
    // needs it to publish a fully-constructed instance across threads.
    private static volatile SessionManager instance;

    private final SharedPreferences prefs;

    private SessionManager(Context appContext) {
        try {
            MasterKey masterKey = new MasterKey.Builder(appContext)
                    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                    .build();
            prefs = EncryptedSharedPreferences.create(
                    appContext,
                    PREFS_FILE,
                    masterKey,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
        } catch (GeneralSecurityException | IOException e) {
            // The keystore or the encrypted file is unusable — there is no
            // reasonable fallback that keeps the "encrypted at rest" promise.
            throw new RuntimeException("Unable to open encrypted session store", e);
        }
    }

    // Called once, from ChessWhisperApplication.onCreate(). getApplicationContext()
    // avoids holding onto whatever Context happens to call this (e.g. an Activity).
    public static void init(Context context) {
        if (instance == null) {
            synchronized (SessionManager.class) {
                if (instance == null) {
                    instance = new SessionManager(context.getApplicationContext());
                }
            }
        }
    }

    public static SessionManager getInstance() {
        return instance;
    }

    public void saveSession(String accessToken, String refreshToken, int userId) {
        prefs.edit()
                .putString(KEY_ACCESS_TOKEN, accessToken)
                .putString(KEY_REFRESH_TOKEN, refreshToken)
                .putInt(KEY_USER_ID, userId)
                .apply();
    }

    public void clearSession() {
        prefs.edit().clear().apply();
    }

    public String getAccessToken() {
        return prefs.getString(KEY_ACCESS_TOKEN, null);
    }

    public String getRefreshToken() {
        return prefs.getString(KEY_REFRESH_TOKEN, null);
    }

    public int getUserId() {
        return prefs.getInt(KEY_USER_ID, -1);
    }

    // A session "exists" if there is a refresh token — it is valid for 30 days,
    // and an expired access token doesn't matter: ApiClient's authenticator
    // renews it silently on the first 401.
    public boolean hasSession() {
        return getRefreshToken() != null;
    }
}
