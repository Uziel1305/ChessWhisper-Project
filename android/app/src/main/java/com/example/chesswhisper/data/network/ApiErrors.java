package com.example.chesswhisper.data.network;

import com.google.gson.Gson;
import com.google.gson.JsonSyntaxException;

import java.io.IOException;

import retrofit2.Response;

/**
 * Turns a failed call into an ApiError the UI can display.
 *
 * Lives here rather than in a repository because every route answers with the
 * same {error, message} envelope, so every repository needs the same parsing.
 */
public final class ApiErrors {
    //static helpers only, never instantiated
    private ApiErrors(){}

    // For a response that arrived but was not a success: 401, 404, 409, 400.
    public static ApiError from(Response<?> response){
        try {
            if (response.errorBody() != null) {
                ApiError parsed = new Gson().fromJson(response.errorBody().string(), ApiError.class);
                // Gson returns null for an empty body rather than throwing.
                if (parsed != null) {
                    return parsed;
                }
            }
        } catch (IOException | JsonSyntaxException e) {
            // fall through to the fallback below
        }
        return unknown();
    }
    // For a request that never got an answer at all: server down, no network,
    // timeout. There is no error body to read, so the app synthesises one.
    public static ApiError network() {
        return new ApiError("network_error", "Unable to reach server. Check your connection.");
    }

    // For a body that arrived but could not be understood.
    public static ApiError unknown() {
        return new ApiError("unknown_error", "Something went wrong. Please try again.");
    }




}
