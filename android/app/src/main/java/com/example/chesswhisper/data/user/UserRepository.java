package com.example.chesswhisper.data.user;

import com.example.chesswhisper.data.network.ApiClient;
import com.example.chesswhisper.data.network.ApiError;
import com.example.chesswhisper.data.network.ApiErrors;
import com.example.chesswhisper.data.user.model.MeResponse;

import retrofit2.Call;
import retrofit2.Callback;
import retrofit2.Response;


// Wraps UserApi so the rest of the app never deals with Retrofit types directly.
// Its job is to turn an HTTP result into either a success or an ApiError.
public class UserRepository {
    // Two outcomes only, so the ViewModel never has to inspect status codes.

    public interface MeCallback{
        void onSuccess(MeResponse response);
        void onError(ApiError error);
    }

    private final UserApi userApi=ApiClient.getUserApi();
    public void me(String accessToken, MeCallback callback){
        // The one place the "Bearer " prefix is written. CW-11's interceptor
        // takes this over, and the accessToken parameter goes away with it.
        Call<MeResponse> call= userApi.me("Bearer "+ accessToken);
        //callback indicates what do after sending the request
        Callback<MeResponse> callback2= new Callback<MeResponse>() {
            // Reached whenever the server answered at all — including 401 and 404.
            // "The request completed" is not the same as "it succeeded".
            @Override
            public void onResponse(Call<MeResponse> call, Response<MeResponse> response) {
                if(response.isSuccessful() && response.body()!= null){
                    callback.onSuccess(response.body());
                }else{
                    // 401 unauthorized / access_token_expired and 404
                    // user_not_found all land here.
                    callback.onError(ApiErrors.from(response));
                }
            }

            @Override
            public void onFailure(Call<MeResponse> call, Throwable t) {
                // Reached only when the request never got an answer: server down, no
                // network, timeout. There is no error body to read.
                callback.onError(ApiErrors.network());
            }
        };
        call.enqueue(callback2);

    }
}
