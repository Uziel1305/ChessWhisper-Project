package com.example.chesswhisper.ui.register;
import androidx.annotation.NonNull;
import androidx.lifecycle.LiveData;
import androidx.lifecycle.MutableLiveData;
import androidx.lifecycle.ViewModel;
import com.example.chesswhisper.data.network.ApiError;
import com.example.chesswhisper.data.auth.AuthRepository;
import com.example.chesswhisper.data.auth.model.RegisterResponse;

public class RegisterViewModel extends ViewModel{
    public enum Status {IDLE, LOADING,SUCCESS,ERROR};
    public static final class RegisterState{
        public final Status status;
        public final ApiError error;
        RegisterState(Status status, ApiError error){
            this.status=status;
            this.error= error;
        }
    }
    private final AuthRepository authRepository=new AuthRepository();
    private final MutableLiveData<RegisterState> state=new MutableLiveData<>(new RegisterState(Status.IDLE,null));

    public LiveData<RegisterState> getState() {
        return state;
    }
    public void register(@NonNull String username, @NonNull String password){
        state.setValue(new RegisterState(Status.LOADING,null));
        authRepository.register(username, password, new AuthRepository.RegisterCallback() {
            @Override
            public void onSuccess(RegisterResponse response) {
                state.setValue(new RegisterState(Status.SUCCESS,null));
            }

            @Override
            public void onError(ApiError error) {
                state.setValue(new RegisterState(Status.ERROR,error));

            }
        });
    }
}
