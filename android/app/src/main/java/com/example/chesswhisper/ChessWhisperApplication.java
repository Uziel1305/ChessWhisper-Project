package com.example.chesswhisper;

import android.app.Application;

import com.example.chesswhisper.data.auth.SessionManager;

// Application.onCreate runs before any Activity, so this is the one place
// guaranteed to run early enough to hand SessionManager its Context before
// MainActivity's first hasSession() check.
public class ChessWhisperApplication extends Application {

    @Override
    public void onCreate() {
        super.onCreate();
        SessionManager.init(this);
    }
}
