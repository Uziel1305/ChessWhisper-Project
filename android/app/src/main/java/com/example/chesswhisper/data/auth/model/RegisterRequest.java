package com.example.chesswhisper.data.auth.model;

/**
 * Request body for POST /api/auth/register.
 *
 * Gson serialises these fields by reflection, so their names must match what
 * auth.routes.js destructures out of req.body. That is also why no getters are
 * needed here. The fields are final because a request is never mutated after
 * it is built.
 */
public class RegisterRequest {
    private final String username;
    private final String password;

    public RegisterRequest(String username, String password) {
        this.username = username;
        this.password = password;
    }
}
