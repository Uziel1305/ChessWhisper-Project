package com.example.chesswhisper.ui.home;

import androidx.annotation.NonNull;
import androidx.lifecycle.LiveData;
import androidx.lifecycle.MutableLiveData;
import androidx.lifecycle.ViewModel;

import com.example.chesswhisper.data.network.ApiError;
import com.example.chesswhisper.data.user.UserRepository;
import com.example.chesswhisper.data.user.model.MeResponse;


// Holds the home screen's state. Being a ViewModel, it survives rotation — so an
// in-flight request is not restarted and its result is not lost.
public class HomeViewModel extends ViewModel {
    public enum Status {IDLE, LOADING, SUCCESS, ERROR,    NO_TOKEN     };

    // Immutable snapshot of the screen. One object means status, error and
    // profile can never disagree, unlike three separate LiveData fields.
    public static final class HomeState {
        public final Status status;
        public final ApiError error;
        public final MeResponse profile;

        // Package-private: only this ViewModel is allowed to produce a state.
        HomeState(Status status, ApiError error, MeResponse profile) {
            this.status = status;
            this.error = error;
            this.profile = profile;
        }
    }
    private final UserRepository userRepository=new UserRepository();
    // Mutable internally, exposed read-only below so the Activity can observe
    // but never write. Seeded with IDLE so getValue() is never null.
    private final MutableLiveData<HomeState> state =
            new MutableLiveData<>(new HomeState(Status.IDLE, null, null));

    public LiveData<HomeState> getState() {
        return state;
    }
    public void load(String accessToken){
        Status current= state.getValue().status;
        // The Activity calls this from onCreate, which runs again on every
        // rotation — but this ViewModel survives, so the request must not be
        // re-sent. ERROR deliberately falls through, so retry works.
        if(current==Status.LOADING || current==Status.SUCCESS){
            return;
        }
        // Nothing to send. Until CW-11 there is no login to produce a token,
        // so this is the normal path rather than an edge case.
        if (accessToken == null) {
            state.setValue(new HomeState(Status.NO_TOKEN, null, null));
            return;
        }
        state.setValue(new HomeState(Status.LOADING,null,null));
        userRepository.me(accessToken, new UserRepository.MeCallback() {
            @Override
            public void onSuccess(MeResponse response) {
                state.setValue(new HomeState(Status.SUCCESS,null, response));
            }
            @Override
            public void onError(ApiError error) {
                state.setValue(new HomeState(Status.ERROR,error,null));
            }
        });
    }

}
