package com.example.chesswhisper.ui.game;

import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.View;
import android.widget.Button;
import android.widget.TextView;

import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;

import com.example.chesswhisper.R;
import com.example.chesswhisper.data.game.GameSocket;
import com.example.chesswhisper.data.game.model.GameEnd;
import com.example.chesswhisper.data.game.model.MatchFound;
import com.example.chesswhisper.data.game.model.MoveCommitted;
import com.example.chesswhisper.ui.home.HomeActivity;

import java.util.List;
import java.util.Locale;

// Hosts BoardView. Reached from Home's playButton on match.found (CW-41) — but also
// still launchable directly (adb) with no MatchFound extra for a bare manual check,
// in which case BoardView keeps its own hardcoded starting position and the clocks
// stay hidden.
public class GameActivity extends AppCompatActivity {

    public static final String EXTRA_MATCH_FOUND = "match_found";

    // Not specified anywhere: long enough that a slow-but-fine connection doesn't
    // misfire, short enough that a genuinely dead socket doesn't strand the player.
    private static final long SEND_TIMEOUT_MS = 8000;

    private static final String TAG = "GameActivity";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private BoardView boardView;
    private TextView opponentNameText;
    private TextView opponentRatingText;
    private TextView opponentClockText;
    private TextView myClockText;
    private Button resignButton;
    private String gameId;
    private String myColor;
    // True once game.end has arrived — tells the Back-button handler apart a
    // still-live game (confirm before leaving) from one already over (let the
    // user through, nothing left to resign).
    private boolean gameEnded = false;
    // Whoever is to move right now. Starts "white" — the server always starts
    // white's clock first — and flips on every move.committed. Never guessed
    // any other way.
    private String currentTurnColor = "white";
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
    // Re-enables input if a sent move never gets a move.committed back (dead
    // socket, or an invalid move the server silently dropped) — per the server's
    // "never answers an invalid move" contract, nothing else would ever unstick it.
    private final Runnable sendTimeoutRunnable = () -> boardView.setInputEnabled(true);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_game);

        boardView = findViewById(R.id.boardView);
        opponentNameText = findViewById(R.id.opponentNameText);
        opponentRatingText = findViewById(R.id.opponentRatingText);
        opponentClockText = findViewById(R.id.opponentClockText);
        myClockText = findViewById(R.id.myClockText);
        resignButton = findViewById(R.id.resignButton);
        resignButton.setOnClickListener(v -> confirmResign());

        // Leaving mid-game (Back) is treated the same as tapping Resign - the
        // same confirm dialog, the same resign() call, no duplicate flow. Once
        // the game has already ended, or there was never a live game to begin
        // with (the no-MatchFound manual-launch path), Back falls through to
        // the default behavior instead.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (gameId != null && !gameEnded) {
                    confirmResign();
                } else {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                }
            }
        });

        MatchFound matchFound = (MatchFound) getIntent().getSerializableExtra(EXTRA_MATCH_FOUND);
        if (matchFound != null) {
            gameId = matchFound.gameId;
            myColor = matchFound.color;
            boardView.setFlipped(!"white".equals(myColor));
            boardView.setPosition(matchFound.fen, matchFound.legalMoves);
            boardView.setInputEnabled(myColor.equals(currentTurnColor));
            if (matchFound.opponent != null) {
                opponentNameText.setText(matchFound.opponent.username);
                opponentRatingText.setText(String.valueOf(matchFound.opponent.rating));
                opponentNameText.setVisibility(View.VISIBLE);
                opponentRatingText.setVisibility(View.VISIBLE);
            }
            if (matchFound.clocks != null) {
                startClocks(matchFound);
            }
            GameSocket.getInstance().setGameListener(new GameSocket.GameListener() {
                @Override
                public void onMoveCommitted(MoveCommitted event) {
                    runOnUiThread(() -> handleMoveCommitted(event));
                }

                @Override
                public void onGameEnd(GameEnd event) {
                    runOnUiThread(() -> handleGameEnd(event));
                }

                @Override
                public void onFailure(Throwable t) {
                    // Nothing to recover to here beyond what the send-timeout already
                    // covers — a mid-game connection loss isn't otherwise handled
                    // (that needs reconnect support, which doesn't exist yet).
                    Log.d(TAG, "game socket failure", t);
                }
            });
        }

        boardView.setOnMoveListener(new BoardView.OnMoveListener() {
            @Override
            public void onMoveSelected(String uci) {
                sendMove(uci);
            }

            @Override
            public void onPromotionNeeded(String from, String to, List<String> candidateUcis) {
                PromotionPickerDialog.show(GameActivity.this, candidateUcis, GameActivity.this::sendMove);
            }
        });
    }

    // Only path that ever sends a move — from a direct tap or from the promotion
    // picker. Only ever a uci BoardView produced from the legalMoves it was given,
    // and only ever this game's real gameId (from match.found) — never invented.
    private void sendMove(String uci) {
        if (gameId == null) {
            // No live game (the CW-49-style manual adb launch, no MatchFound
            // extra) — nothing to send to, same as before this ticket.
            Log.d(TAG, "move selected (no live game): " + uci);
            return;
        }
        boardView.setInputEnabled(false);
        handler.postDelayed(sendTimeoutRunnable, SEND_TIMEOUT_MS);
        GameSocket.getInstance().sendMove(gameId, uci);
    }

    private void handleMoveCommitted(MoveCommitted event) {
        handler.removeCallbacks(sendTimeoutRunnable);
        boardView.setPosition(event.fen, event.legalMoves);
        currentTurnColor = "white".equals(currentTurnColor) ? "black" : "white";
        boardView.setInputEnabled(myColor.equals(currentTurnColor));

        // Resync from the server's authoritative values rather than continuing
        // to predict off the match.found snapshot — this is what makes the
        // now-to-move side's clock actually start ticking on screen.
        if (event.clocks != null) {
            whiteRemainingMs = event.clocks.white;
            blackRemainingMs = event.clocks.black;
            tickStartedAtElapsedRealtime = SystemClock.elapsedRealtime();
            updateClockDisplay();
        }
    }

    private void handleGameEnd(GameEnd event) {
        gameEnded = true;
        handler.removeCallbacks(sendTimeoutRunnable);
        boardView.setInputEnabled(false);
        GameResultDialog.show(this, event.result, event.reason, event.newRating, event.ratingDelta,
                this::goToHome);
    }

    private void confirmResign() {
        new AlertDialog.Builder(this)
                .setTitle(R.string.resign_confirm_title)
                .setMessage(R.string.resign_confirm_message)
                .setPositiveButton(R.string.resign, (dialog, which) -> resign())
                .setNegativeButton(R.string.resign_confirm_cancel, null)
                .show();
    }

    // Only path that ever sends a resignation — from confirmResign()'s dialog.
    // No send-timeout/retry the way sendMove has: unlike a move, there is
    // nothing to recover to if this is dropped, so the button just stays
    // disabled until game.end arrives and the result dialog takes over.
    private void resign() {
        if (gameId == null) {
            return;
        }
        resignButton.setEnabled(false);
        GameSocket.getInstance().resign(gameId);
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
        tickStartedAtElapsedRealtime = SystemClock.elapsedRealtime();
        iAmWhite = "white".equals(matchFound.color);

        opponentClockText.setVisibility(View.VISIBLE);
        myClockText.setVisibility(View.VISIBLE);
        resignButton.setVisibility(View.VISIBLE);
        updateClockDisplay();

        handler.post(clockTickRunnable);
    }

    private void updateClockDisplay() {
        long elapsed = SystemClock.elapsedRealtime() - tickStartedAtElapsedRealtime;
        long liveWhite = "white".equals(currentTurnColor)
                ? Math.max(0, whiteRemainingMs - elapsed) : whiteRemainingMs;
        long liveBlack = "black".equals(currentTurnColor)
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
        handler.removeCallbacks(sendTimeoutRunnable);
        // isFinishing() is false for a rotation-triggered recreate, where the
        // connection must stay open — only a real exit closes it. Same pattern
        // LoginActivity uses to tell a real destroy apart from one that isn't.
        if (isFinishing()) {
            GameSocket.getInstance().disconnect();
        }
    }
}
