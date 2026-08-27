package com.example.chesswhisper.ui;

import android.content.Intent;
import android.os.Bundle;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;

import com.example.chesswhisper.data.auth.SessionManager;
import com.example.chesswhisper.ui.login.LoginActivity;

/**
 * Base class for every screen that requires a session.
 *
 * When a session ends without the user asking — a refresh that failed because the
 * refresh token was expired, revoked or replayed — the screen returns to login on
 * its own. No individual screen has to work out what a 401 really meant, which is
 * the same principle as the app carrying no token logic above the HTTP layer.
 */
public abstract class SessionAwareActivity extends AppCompatActivity {

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        SessionManager.getInstance().getSessionEnded().observe(this, ended -> {
            if (Boolean.TRUE.equals(ended)) {
                goToLogin();
            }
        });
    }

    private void goToLogin() {
        Intent intent = new Intent(this, LoginActivity.class);
        // Wipes everything beneath, so "back" cannot walk into a screen that
        // needs the session we just lost.
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        startActivity(intent);
        finish();
    }
}