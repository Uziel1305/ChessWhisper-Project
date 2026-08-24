package com.example.chesswhisper.data.auth.model;

/**
 * Request body for POST /api/auth/login. Same shape and rationale as
 * RegisterRequest: field names must match what auth.routes.js destructures
 * out of req.body, and there are no getters because Gson serialises by
 * reflection on the way out, never reads it back.
 */
public class LoginRequest {
    private final String username;
    private final String password;

    public LoginRequest(String username, String password) {
        this.username = username;
        this.password = password;
    }
}
