package com.example.chesswhisper.data.auth.model;

/**
 * Body of a successful (201) POST /api/auth/register response.
 *
 * There is deliberately no constructor: Gson instantiates this and fills userId
 * reflectively, so the field name has to stay in sync with the server's
 * res.status(201).json({ userId: user.id }).
 */
public class RegisterResponse {
    private int userId;

    public int getUserId() {
        return userId;
    }
}
