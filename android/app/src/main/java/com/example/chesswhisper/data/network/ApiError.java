package com.example.chesswhisper.data.network;

public class ApiError {
    private String error;
    private String message;

    public ApiError(String error, String message) {
        this.error = error;
        this.message = message;
    }

    public String getError() {
        return error;
    }

    public String getMessage() {
        return message;
    }
}
