package com.example.chesswhisper.network;

public class RegisterRequest {
    private final String username;
    private final String password;

    public RegisterRequest(String username, String password) {
        this.username = username;
        this.password = password;
    }
}
