package com.example.chesswhisper.ui.register;
import androidx.annotation.NonNull;
import androidx.lifecycle.LiveData;
import androidx.lifecycle.MutableLiveData;
import androidx.lifecycle.ViewModel;
import com.example.chesswhisper.data.network.ApiError;
import com.example.chesswhisper.data.auth.AuthRepository;
import com.example.chesswhisper.data.auth.model.RegisterResponse;

// Holds the register screen's state. Being a ViewModel, it survives rotation —
// so an in-flight request is not restarted and its result is not lost.
public class RegisterViewModel extends ViewModel{

    public enum Status {IDLE, LOADING,SUCCESS,ERROR};

    // Immutable snapshot of the screen. One object means status and error can
    // never disagree, unlike two separate LiveData fields.
    public static final class RegisterState{
        public final Status status;
        public final ApiError error;

        // Package-private: only this ViewModel is allowed to produce a state.
        RegisterState(Status status, ApiError error){
            this.status=status;
            this.error= error;
        }
    }

    private final AuthRepository authRepository=new AuthRepository();

    // Mutable internally, exposed read-only below so the Activity can observe
    // but never write.
    private final MutableLiveData<RegisterState> state=new MutableLiveData<>(new RegisterState(Status.IDLE,null));

    public LiveData<RegisterState> getState() {
        return state;
    }

    public void register(@NonNull String username, @NonNull String password){
        // Flip to LOADING first so the UI shows the spinner and disables the
        // button before the request goes out.
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
