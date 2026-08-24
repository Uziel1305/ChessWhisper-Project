package com.example.chesswhisper.data.user.model;
/**
 * Body of a successful GET /api/users/me response.
 *
 * No constructor, same as RegisterResponse: Gson fills these reflectively, so
 * the field names have to stay in sync with the server's
 * res.status(200).json({ username, rating }).
 */
public class MeResponse {
    private String username;
    private int rating;

    public String getUsername() { return username; }
    public int getRating() { return rating; }
}
