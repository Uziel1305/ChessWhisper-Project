package com.example.chesswhisper.data.network;

/**
 * The server's error envelope: {"error": "...", "message": "..."}. Every failed
 * REST call returns this shape, which is why it lives in network/ rather than
 * with the auth models.
 *
 * It is built two different ways. Gson fills the fields reflectively when
 * parsing a real error body from the server, and the explicit constructor lets
 * the app synthesise one for failures that never reached the server at all —
 * see AuthRepository.onFailure.
 */
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
