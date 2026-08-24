package com.example.chesswhisper.data.auth.model;

/**
 * Body of a successful (200) POST /api/auth/login response. No constructor,
 * same as RegisterResponse: Gson fills these reflectively, so the field names
 * have to stay in sync with the server's
 * res.status(200).json({ accessToken, refreshToken, userId }).
 */
public class LoginResponse {
    private String accessToken;
    private String refreshToken;
    private int userId;

    public String getAccessToken() {
        return accessToken;
    }

    public String getRefreshToken() {
        return refreshToken;
    }

    public int getUserId() {
        return userId;
    }
}
