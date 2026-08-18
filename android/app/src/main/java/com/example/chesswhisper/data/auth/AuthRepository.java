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


public class AuthRepository {
    public interface RegisterCallback{
        void onSuccess(RegisterResponse response);
        void onError(ApiError error);
    }
    private final AuthApi authApi= ApiClient.getAuthApi();
    public void register(String username, String password, RegisterCallback callback){
        RegisterRequest request= new RegisterRequest(username, password);
        Call<RegisterResponse> call=authApi.register(request);
        Callback<RegisterResponse> callback2=new Callback<RegisterResponse>() {
            @Override
            public void onResponse(Call<RegisterResponse> call, Response<RegisterResponse> response) {
                if(response.isSuccessful() && response.body()!=null){
                    callback.onSuccess(response.body());
                }else{
                    callback.onError(parseError(response));
                }
            }

            @Override
            public void onFailure(Call<RegisterResponse> call, Throwable t) {
                callback.onError(new ApiError("network_error", "Unable to reach server. Check your connection."));
            }
        };
        call.enqueue(callback2);
    }
    private ApiError parseError(Response<RegisterResponse> response) {
        try {
            if (response.errorBody() != null) {
                return new Gson().fromJson(response.errorBody().string(), ApiError.class);
            }
        } catch (IOException e) {
            // fall through
        }
        return new ApiError("unknown_error", "Something went wrong. Please try again.");
    }

}
