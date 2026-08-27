package com.example.chesswhisper.data.auth.model;

/**
 * Request body for both POST /api/auth/refresh and POST /api/auth/logout —
 * the server expects the identical {refreshToken} shape for each, so one
 * model class serves both calls.
 */
public class RefreshTokenRequest {
    private final String refreshToken;

    public RefreshTokenRequest(String refreshToken) {
        this.refreshToken = refreshToken;
    }
}
