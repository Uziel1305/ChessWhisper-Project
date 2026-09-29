package com.example.chesswhisper.ui.home;

import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.activity.EdgeToEdge;
import androidx.activity.SystemBarStyle;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.lifecycle.Observer;
import androidx.lifecycle.ViewModelProvider;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import com.example.chesswhisper.R;
import com.example.chesswhisper.data.auth.SessionManager;
import com.example.chesswhisper.ui.SessionAwareActivity;
import com.example.chesswhisper.ui.game.GameActivity;
import com.google.android.material.button.MaterialButton;
import com.google.android.material.button.MaterialButtonToggleGroup;

// The home screen. It only renders state — the username and rating come straight
// from GET /api/users/me and are never computed or cached here.

public class HomeActivity extends SessionAwareActivity {

    private View successGroup;
    private View errorGroup;
    private TextView usernameText;
    private TextView ratingText;
    private TextView errorText;
    private ProgressBar progressBar;
    private MaterialButton retryButton;
    private MaterialButton playButton;
    private MaterialButtonToggleGroup modePicker;
    private TextView gamesText;
    private RecyclerView historyList;
    private TextView historyEmpty;
    private final GameHistoryAdapter historyAdapter = new GameHistoryAdapter();
    private HomeViewModel viewModel;
    // Registered as a field initializer so it exists before onStart, as the
    // Activity Result API requires. When the game screen finishes — for any
    // reason, so the result code is ignored — the rating and history have both
    // changed, and this Home (which stayed alive underneath) re-fetches them.
    // This is the only refresh trigger: onResume also runs on first open, where
    // load() has already sent the requests.
    private final ActivityResultLauncher<Intent> gameLauncher = registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(),
            result -> viewModel.refresh());
    // render() and renderMatchmaking() fire from separate LiveData observers, so
    // playButton's enabled state (profile loaded AND not already connecting) needs
    // the latest value from both, not just whichever fired last.
    private boolean profileLoaded = false;
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Draws behind the status and navigation bars; the listener below pads
        // the content back out from underneath them. Always light bar icons:
        // the app is dark-only, and the default auto style would pick dark
        // icons whenever the phone itself is in light mode.
        EdgeToEdge.enable(this,
                SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT));
        setContentView(R.layout.activity_home);
        // Only the system bars here, unlike RegisterActivity. The hero image is
        // full-bleed and runs up under the status bar, so the top inset pads the
        // text over it (heroContent) rather than the root.
        View heroContent = findViewById(R.id.heroContent);
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.home), (v, insets) -> {
            Insets systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            v.setPadding(systemBars.left, 0, systemBars.right, systemBars.bottom);
            heroContent.setPadding(heroContent.getPaddingLeft(), systemBars.top,
                    heroContent.getPaddingRight(), heroContent.getPaddingBottom());
            return insets;
        });
        errorGroup=findViewById(R.id.errorGroup);
        successGroup=findViewById(R.id.successGroup);
        usernameText=findViewById(R.id.usernameText);
        ratingText = findViewById(R.id.ratingText);
        errorText = findViewById(R.id.errorText);
        progressBar = findViewById(R.id.progressBar);
        retryButton = findViewById(R.id.retryButton);
        playButton = findViewById(R.id.playButton);
        modePicker = findViewById(R.id.modePicker);
        gamesText = findViewById(R.id.gamesText);
        historyList = findViewById(R.id.historyList);
        historyEmpty = findViewById(R.id.historyEmpty);
        historyList.setLayoutManager(new LinearLayoutManager(this));
        historyList.setAdapter(historyAdapter);
        // Tied to this Activity, so the same instance comes back after rotation.
        viewModel= new ViewModelProvider(this).get(HomeViewModel.class);
        bindModePicker();
        viewModel.getHistoryState().observe(this, this::renderHistory);
        viewModel.getState().observe(this, new Observer<HomeViewModel.HomeState>() {
            @Override
            public void onChanged(HomeViewModel.HomeState homeState) {
                render(homeState);
            }
        });
        viewModel.getMatchmakingState().observe(this, this::renderMatchmaking);
        retryButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                load();
            }
        });
        // Queues with whatever the picker has selected (HomeViewModel holds it).
        playButton.setOnClickListener(v -> viewModel.play());
        load();
    }
    private void load(){
        viewModel.load();
    }

    // Labels come from GameMode, and the checked button is set from the
    // ViewModel's selection rather than left to the view's own saved state — so
    // after rotation the ViewModel, not the widget, is what decides the mode.
    // pickerModes(), never values(): retraction is a known mode but has no
    // button, and buttonIdFor() would map it onto Classic's.
    private void bindModePicker() {
        for (GameMode mode : GameMode.pickerModes()) {
            MaterialButton button = findViewById(buttonIdFor(mode));
            button.setText(mode.labelRes);
        }
        modePicker.check(buttonIdFor(viewModel.getSelectedMode()));
        modePicker.addOnButtonCheckedListener((group, checkedId, isChecked) -> {
            // selectionRequired means a click never leaves nothing checked, but
            // it still reports the previous button being unchecked — ignore that.
            if (!isChecked) return;
            for (GameMode mode : GameMode.pickerModes()) {
                if (buttonIdFor(mode) == checkedId) {
                    viewModel.selectMode(mode);
                    return;
                }
            }
        });
    }

    // A switch on the enum, not on R.id values: resource ids are not
    // compile-time constants under current Android Gradle Plugin defaults.
    private static int buttonIdFor(GameMode mode) {
        switch (mode) {
            case EVAL:
                return R.id.modeEvalButton;
            case FEEDBACK:
                return R.id.modeFeedbackButton;
            case CLASSIC:
            default:
                return R.id.modeClassicButton;
        }
    }
    
    // Single place that turns a state into what is on screen. All three groups
    // are set unconditionally, so exactly one is visible however you got here
    // and no stale spinner or error survives into the next state.
    public void render(HomeViewModel.HomeState state) {
        progressBar.setVisibility(
                state.status == HomeViewModel.Status.LOADING ? View.VISIBLE : View.GONE);

        successGroup.setVisibility(
                state.status == HomeViewModel.Status.SUCCESS ? View.VISIBLE : View.GONE);

        errorGroup.setVisibility(
                state.status == HomeViewModel.Status.ERROR ? View.VISIBLE : View.GONE);

        if (state.status == HomeViewModel.Status.SUCCESS && state.profile != null) {
            usernameText.setText(state.profile.getUsername());
            ratingText.setText(String.valueOf(state.profile.getRating()));
        }

        if (state.status == HomeViewModel.Status.ERROR && state.error != null) {
            // clearSession() ran on the OkHttp thread before this callback was posted,
            // and apply() updates the in-memory map synchronously — so an ERROR with no
            // session left is always the logged-out case, never a retryable failure.
            if (!SessionManager.getInstance().hasSession()) {
                return;
            }
            errorText.setText(state.error.getMessage());
            retryButton.setEnabled(true);
        }

        profileLoaded = state.status == HomeViewModel.Status.SUCCESS;
        updatePlayButtonEnabled(viewModel.getMatchmakingState().getValue());
    }

    // The history section and the Games counter. It lives inside successGroup,
    // so it is only ever seen alongside a loaded profile. Exactly one of the
    // list and the empty/error text is visible once history has settled.
    private void renderHistory(HomeViewModel.HistoryState state) {
        if (state.status == HomeViewModel.Status.SUCCESS && state.history != null) {
            gamesText.setText(String.valueOf(state.history.getTotal()));
            historyAdapter.submit(state.history.getGames());
            boolean empty = state.history.getGames().isEmpty();
            historyList.setVisibility(empty ? View.GONE : View.VISIBLE);
            historyEmpty.setVisibility(empty ? View.VISIBLE : View.GONE);
            historyEmpty.setText(R.string.home_no_games);
            return;
        }

        // Never show a count that isn't the server's.
        gamesText.setText(R.string.home_games_unknown);
        historyList.setVisibility(View.GONE);
        if (state.status == HomeViewModel.Status.ERROR) {
            historyEmpty.setVisibility(View.VISIBLE);
            historyEmpty.setText(R.string.home_history_error);
        } else {
            historyEmpty.setVisibility(View.GONE);
        }
    }

    // Reacts to matchmaking state changes: navigates to GameActivity once matched,
    // and keeps playButton in sync with whether a connection attempt is in flight.
    private void renderMatchmaking(HomeViewModel.MatchmakingState state) {
        updatePlayButtonEnabled(state);

        if (state.status == HomeViewModel.MatchmakingStatus.MATCHED) {
            Intent intent = new Intent(this, GameActivity.class);
            intent.putExtra(GameActivity.EXTRA_MATCH_FOUND, state.matchFound);
            // match.found describes only the opponent; the game screen's own
            // player card shows what /users/me already gave this screen. Play is
            // only enabled once that profile has loaded, so it is present here.
            HomeViewModel.HomeState home = viewModel.getState().getValue();
            if (home != null && home.profile != null) {
                intent.putExtra(GameActivity.EXTRA_MY_USERNAME, home.profile.getUsername());
                intent.putExtra(GameActivity.EXTRA_MY_RATING, home.profile.getRating());
            }
            gameLauncher.launch(intent);
            // Consumed as soon as it is acted on. LiveData replays its current
            // value to every new observer, so a MATCHED left standing would
            // reopen the game on rotation or on the way back from it.
            viewModel.onMatchLaunched();
        }
        // ERROR is deliberately silent beyond re-enabling the button — no retry UI
        // was asked for; the player can just tap Play again.
    }

    private void updatePlayButtonEnabled(HomeViewModel.MatchmakingState matchmakingState) {
        boolean connecting = matchmakingState != null
                && matchmakingState.status == HomeViewModel.MatchmakingStatus.CONNECTING;
        playButton.setEnabled(profileLoaded && !connecting);
        // The mode is fixed once queue.join has gone out; changing the picker
        // mid-queue would show a mode the player isn't actually waiting in. Each
        // button is disabled individually — a ViewGroup's own enabled flag
        // doesn't reach its children.
        for (int i = 0; i < modePicker.getChildCount(); i++) {
            modePicker.getChildAt(i).setEnabled(!connecting);
        }
    }

}