package com.example.chesswhisper.data.auth;
import com.example.chesswhisper.data.network.ApiClient;
import com.example.chesswhisper.data.network.ApiError;
import com.example.chesswhisper.data.auth.model.RegisterRequest;
import com.example.chesswhisper.data.auth.model.RegisterResponse;
import com.google.gson.Gson;
import java.io.IOException;
import retrofit2.Call;
import retrofit2.Callback;
import retrofit2.Response;


// Wraps AuthApi so the rest of the app never deals with Retrofit types directly.
// Its job is to turn an HTTP result into either a success or an ApiError.
public class AuthRepository {

    // Two outcomes only, so the ViewModel never has to inspect status codes.
    public interface RegisterCallback{
        void onSuccess(RegisterResponse response);
        void onError(ApiError error);
    }

    private final AuthApi authApi= ApiClient.getAuthApi();

    public void register(String username, String password, RegisterCallback callback){
        RegisterRequest request= new RegisterRequest(username, password);
        Call<RegisterResponse> call=authApi.register(request);
        Callback<RegisterResponse> callback2=new Callback<RegisterResponse>() {

            // Reached whenever the server answered at all — including 400 and 409.
            // "The request completed" is not the same as "it succeeded".
            @Override
            public void onResponse(Call<RegisterResponse> call, Response<RegisterResponse> response) {
                if(response.isSuccessful() && response.body()!=null){
                    callback.onSuccess(response.body());
                }else{
                    // 400 validation_error / 409 username_taken land here.
                    callback.onError(parseError(response));
                }
            }

            // Reached only when the request never got an answer: server down, no
            // network, timeout. There is no error body to read, so we build our own.
            @Override
            public void onFailure(Call<RegisterResponse> call, Throwable t) {
                callback.onError(new ApiError("network_error", "Unable to reach server. Check your connection."));
            }
        };
        // enqueue runs the call on a background thread and delivers both callbacks
        // back on the main thread, which is why the ViewModel can use setValue.
        call.enqueue(callback2);
    }

    // Turns the server's JSON error body into an ApiError the UI can display.
    private ApiError parseError(Response<RegisterResponse> response) {
        try {
            if (response.errorBody() != null) {
                return new Gson().fromJson(response.errorBody().string(), ApiError.class);
            }
        } catch (IOException e) {
            // fall through
        }
        // Fallback for an unreadable or missing body — the user still gets
        // something sensible rather than a blank error line.
        return new ApiError("unknown_error", "Something went wrong. Please try again.");
    }

}
