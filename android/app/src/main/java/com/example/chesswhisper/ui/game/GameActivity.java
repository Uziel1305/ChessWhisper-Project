package com.example.chesswhisper.ui.game;

import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.View;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;

import com.example.chesswhisper.R;
import com.example.chesswhisper.data.game.model.MatchFound;
import com.example.chesswhisper.ui.home.HomeActivity;

import java.util.List;
import java.util.Locale;

// Hosts BoardView. Reached from Home's playButton on match.found (CW-41) — but also
// still launchable directly (adb) with no MatchFound extra for a bare manual check,
// in which case BoardView keeps its own hardcoded starting position and the clocks
// stay hidden.
public class GameActivity extends AppCompatActivity {

    public static final String EXTRA_MATCH_FOUND = "match_found";

    private static final String TAG = "GameActivity";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private TextView opponentClockText;
    private TextView myClockText;
    // Which side's TextView is currently ticking down — always "white" for now.
    // TODO(move.committed): flip this (and re-sync both remaining values from the
    // server) once that event exists; nothing currently ever changes whose turn it is.
    private String tickingColor;
    private long whiteRemainingMs;
    private long blackRemainingMs;
    private long tickStartedAtElapsedRealtime;
    private boolean iAmWhite;
    private final Runnable clockTickRunnable = new Runnable() {
        @Override
        public void run() {
            updateClockDisplay();
            handler.postDelayed(this, 1000);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_game);

        BoardView boardView = findViewById(R.id.boardView);
        opponentClockText = findViewById(R.id.opponentClockText);
        myClockText = findViewById(R.id.myClockText);

        MatchFound matchFound = (MatchFound) getIntent().getSerializableExtra(EXTRA_MATCH_FOUND);
        if (matchFound != null) {
            boardView.setPosition(matchFound.fen, matchFound.legalMoves);
            if (matchFound.clocks != null) {
                startClocks(matchFound);
            }
        }

        boardView.setOnMoveListener(new BoardView.OnMoveListener() {
            @Override
            public void onMoveSelected(String uci) {
                // GameSocket only handles queue.join/match.found so far — sending a
                // move isn't wired yet, so this just logs to confirm the tap ->
                // select -> highlight -> move flow.
                Log.d(TAG, "move selected: " + uci);
            }

            @Override
            public void onPromotionNeeded(String from, String to, List<String> candidateUcis) {
                PromotionPickerDialog.show(GameActivity.this, candidateUcis,
                        uci -> Log.d(TAG, "move selected: " + uci));
            }
        });
    }

    private void goToHome() {
        startActivity(new Intent(this, HomeActivity.class));
        finish();
    }

    // Local prediction, not authority: ticks visually between server updates so the
    // display doesn't sit frozen, but a clock reaching 0:00 here does nothing on its
    // own — only the server's timeout callback (Game.js) can actually end the game.
    private void startClocks(MatchFound matchFound) {
        whiteRemainingMs = matchFound.clocks.white;
        blackRemainingMs = matchFound.clocks.black;
        tickingColor = "white";
        tickStartedAtElapsedRealtime = SystemClock.elapsedRealtime();
        iAmWhite = "white".equals(matchFound.color);

        opponentClockText.setVisibility(View.VISIBLE);
        myClockText.setVisibility(View.VISIBLE);
        updateClockDisplay();

        handler.post(clockTickRunnable);
    }

    private void updateClockDisplay() {
        long elapsed = SystemClock.elapsedRealtime() - tickStartedAtElapsedRealtime;
        long liveWhite = "white".equals(tickingColor)
                ? Math.max(0, whiteRemainingMs - elapsed) : whiteRemainingMs;
        long liveBlack = "black".equals(tickingColor)
                ? Math.max(0, blackRemainingMs - elapsed) : blackRemainingMs;

        opponentClockText.setText(formatClock(iAmWhite ? liveBlack : liveWhite));
        myClockText.setText(formatClock(iAmWhite ? liveWhite : liveBlack));
    }

    private static String formatClock(long ms) {
        long totalSeconds = ms / 1000;
        return String.format(Locale.US, "%d:%02d", totalSeconds / 60, totalSeconds % 60);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        handler.removeCallbacks(clockTickRunnable);
    }
}
