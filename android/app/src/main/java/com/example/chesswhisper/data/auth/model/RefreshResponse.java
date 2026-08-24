package com.example.chesswhisper.data.auth.model;

/**
 * Body of a successful (200) POST /api/auth/refresh response. No userId here
 * — the server's refresh endpoint doesn't return one, only a renewed token
 * pair (see server/src/rest/auth.routes.js).
 */
public class RefreshResponse {
    private String accessToken;
    private String refreshToken;

    public String getAccessToken() {
        return accessToken;
    }

    public String getRefreshToken() {
        return refreshToken;
    }
}
