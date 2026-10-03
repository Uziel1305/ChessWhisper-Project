package com.example.chesswhisper.ui.home;
import androidx.lifecycle.LiveData;
import androidx.lifecycle.MutableLiveData;
import androidx.lifecycle.ViewModel;

import com.example.chesswhisper.data.game.GameRepository;
import com.example.chesswhisper.data.game.GameSocket;
import com.example.chesswhisper.data.game.model.GameHistoryResponse;
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
        // Each half guards itself, so a retry after the profile failed doesn't
        // refetch a history that already loaded (or the reverse).
        loadHistory();
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

    // Re-fetches the profile and history after a game, when both have changed
    // (a new rating, a new row). Unlike load() it never goes back to LOADING, so
    // the screen keeps showing the old values until the new ones arrive, and a
    // failure keeps them too — stale-but-real beats an error over good data.
    // A dead session needs nothing here: SessionAwareActivity reacts to it.
    public void refresh(){
        userRepository.me(new UserRepository.MeCallback() {
            @Override
            public void onSuccess(MeResponse response) {
                state.setValue(new HomeState(Status.SUCCESS,null, response));
            }
            @Override
            public void onError(ApiError error) {
                // Keep what is on screen.
            }
        });
        fetchHistory();
    }

    // Separate from HomeState, like MatchmakingState below: the history can fail
    // while the profile loaded, and one failing must not hide the other.
    public static final class HistoryState {
        public final Status status;
        public final ApiError error;
        public final GameHistoryResponse history;

        HistoryState(Status status, ApiError error, GameHistoryResponse history) {
            this.status = status;
            this.error = error;
            this.history = history;
        }
    }

    private final GameRepository gameRepository = new GameRepository();

    private final MutableLiveData<HistoryState> historyState =
            new MutableLiveData<>(new HistoryState(Status.IDLE, null, null));

    public LiveData<HistoryState> getHistoryState() {
        return historyState;
    }

    private void loadHistory() {
        Status current = historyState.getValue().status;
        if (current == Status.LOADING || current == Status.SUCCESS) {
            return;
        }
        historyState.setValue(new HistoryState(Status.LOADING, null, null));
        fetchHistory();
    }

    private void fetchHistory() {
        gameRepository.history(new GameRepository.HistoryCallback() {
            @Override
            public void onSuccess(GameHistoryResponse response) {
                historyState.setValue(new HistoryState(Status.SUCCESS, null, response));
            }

            @Override
            public void onError(ApiError error) {
                // On a refresh, a list already on screen stays; only a first
                // load with nothing to show turns into an error.
                if (historyState.getValue().status == Status.SUCCESS) {
                    return;
                }
                historyState.setValue(new HistoryState(Status.ERROR, error, null));
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

    // The picker's selection (CW-155). Held here rather than read back off the
    // toggle group, so it survives rotation along with everything else on this
    // screen, and so the mode queue.join carries is the one the player chose —
    // never a literal.
    private GameMode selectedMode = GameMode.DEFAULT;

    public GameMode getSelectedMode() {
        return selectedMode;
    }

    public void selectMode(GameMode mode) {
        selectedMode = mode;
    }

    // Who the next game is against. Held here for the same reasons as the mode.
    // Choosing ENGINE leaves selectedMode alone — engine games are classic only,
    // so it is simply not used, and it is still there when PLAYER comes back.
    private Opponent selectedOpponent = Opponent.DEFAULT;

    public Opponent getSelectedOpponent() {
        return selectedOpponent;
    }

    public void selectOpponent(Opponent opponent) {
        selectedOpponent = opponent;
    }

    // The listener this screen handed to GameSocket, kept so onCleared() can
    // cancel exactly this screen's matchmaking and nothing newer.
    private GameSocket.MatchListener matchListener;

    public void play() {
        matchmaking.setValue(new MatchmakingState(MatchmakingStatus.CONNECTING, null, null));
        matchListener = new GameSocket.MatchListener() {
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
        };
        if (selectedOpponent == Opponent.ENGINE) {
            // No queue: the server answers at once with match.found. Classic is
            // the only mode the server offers against the engine.
            GameSocket.getInstance().connectAndStartEngineGame(GameMode.CLASSIC.wireValue, matchListener);
        } else {
            GameSocket.getInstance().connectAndJoinQueue(selectedMode.wireValue, matchListener);
        }
    }

    // Called by the Activity right after it launches GameActivity for a match.
    // Back to IDLE so the MATCHED value cannot be replayed into a second launch,
    // and the listener dropped: the match is over as far as this screen is
    // concerned, so onCleared() has no matchmaking of its own left to cancel.
    // (It couldn't cancel anything anyway — GameSocket only acts for the
    // current listener, and GameActivity.disconnect() clears that.)
    public void onMatchLaunched() {
        matchListener = null;
        matchmaking.setValue(new MatchmakingState(MatchmakingStatus.IDLE, null, null));
    }

    // Runs only when Home is finished for good — Back, or the session-ended
    // redirect — never on rotation, and not when a match navigates into the game
    // (Home isn't finished then). Without this, the matchmaking socket outlived
    // the screen: the server kept the player waiting, a later joiner was matched
    // with them, and their match.found landed on this dead ViewModel so they
    // never saw the game (CW-157's ghost-queue bug). Closing the socket lets the
    // server's close handler take them out of the queue.
    //
    // Nothing else needs resetting: a reopened Home gets a new ViewModel, which
    // starts IDLE (picker and Play enabled) with the default mode selected.
    @Override
    protected void onCleared() {
        super.onCleared();
        MatchmakingState current = matchmaking.getValue();
        if (current == null || current.status != MatchmakingStatus.MATCHED) {
            GameSocket.getInstance().cancelMatchmaking(matchListener);
        }
    }

}
