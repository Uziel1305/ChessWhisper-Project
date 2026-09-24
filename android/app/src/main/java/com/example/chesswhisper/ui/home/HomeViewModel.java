package com.example.chesswhisper.ui.home;
import androidx.lifecycle.LiveData;
import androidx.lifecycle.MutableLiveData;
import androidx.lifecycle.ViewModel;

import com.example.chesswhisper.data.game.GameSocket;
import com.example.chesswhisper.data.game.model.MatchFound;
import com.example.chesswhisper.data.network.ApiError;
import com.example.chesswhisper.data.user.UserRepository;
import com.example.chesswhisper.data.user.model.MeResponse;


// Holds the home screen's state. Being a ViewModel, it survives rotation — so an
// in-flight request is not restarted and its result is not lost.
public class HomeViewModel extends ViewModel {
    public enum Status {IDLE, LOADING, SUCCESS, ERROR};

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
    public void load(){
        Status current= state.getValue().status;
        // The Activity calls this from onCreate, which runs again on every
        // rotation — but this ViewModel survives, so the request must not be
        // re-sent. ERROR deliberately falls through, so retry works.
        if(current==Status.LOADING || current==Status.SUCCESS){
            return;
        }
        state.setValue(new HomeState(Status.LOADING,null,null));
        //async code
        userRepository.me(new UserRepository.MeCallback() {
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

    // Independent of HomeState above: the profile can be loaded while matchmaking
    // is idle, mid-connect, matched or errored — one enum would conflate two
    // concerns that can legitimately disagree.
    public enum MatchmakingStatus {IDLE, CONNECTING, MATCHED, ERROR}

    public static final class MatchmakingState {
        public final MatchmakingStatus status;
        public final MatchFound matchFound;
        public final String errorMessage;

        MatchmakingState(MatchmakingStatus status, MatchFound matchFound, String errorMessage) {
            this.status = status;
            this.matchFound = matchFound;
            this.errorMessage = errorMessage;
        }
    }

    private final MutableLiveData<MatchmakingState> matchmaking =
            new MutableLiveData<>(new MatchmakingState(MatchmakingStatus.IDLE, null, null));

    public LiveData<MatchmakingState> getMatchmakingState() {
        return matchmaking;
    }

    // mode travels in as a parameter rather than a literal, per CLAUDE.md's
    // "never a literal" convention for queue.join fields — the same reasoning
    // clock.js's constructor argument already follows for timeControl. Real
    // callers pass "classic" until CW-155 adds a picker on this screen.
    public void play(String mode) {
        matchmaking.setValue(new MatchmakingState(MatchmakingStatus.CONNECTING, null, null));
        GameSocket.getInstance().connectAndJoinQueue(mode, new GameSocket.MatchListener() {
            @Override
            public void onMatchFound(MatchFound matchFound) {
                // postValue: this listener runs on OkHttp's thread, not the main thread.
                matchmaking.postValue(new MatchmakingState(MatchmakingStatus.MATCHED, matchFound, null));
            }

            @Override
            public void onQueueRejected(String error, String message) {
                matchmaking.postValue(new MatchmakingState(MatchmakingStatus.ERROR, null, message));
            }

            @Override
            public void onFailure(Throwable t) {
                matchmaking.postValue(new MatchmakingState(
                        MatchmakingStatus.ERROR, null, "Couldn't reach the server."));
            }
        });
    }

}
