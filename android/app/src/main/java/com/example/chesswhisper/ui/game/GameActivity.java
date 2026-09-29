package com.example.chesswhisper.ui.game;

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
import com.example.chesswhisper.data.game.model.EvalUpdate;
import com.example.chesswhisper.data.game.model.GameEnd;
import com.example.chesswhisper.data.game.model.MatchFound;
import com.example.chesswhisper.data.game.model.MoveCommitted;
import com.example.chesswhisper.data.game.model.MoveFeedback;

import java.util.List;
import java.util.Locale;

// Hosts BoardView. Reached from Home's playButton on match.found (CW-41) — but also
// still launchable directly (adb) with no MatchFound extra for a bare manual check,
// in which case BoardView keeps its own hardcoded starting position and the clocks
// stay hidden.
public class GameActivity extends AppCompatActivity {

    public static final String EXTRA_MATCH_FOUND = "match_found";
    // The local player's own name and rating, from Home's /users/me profile —
    // match.found only carries the opponent's.
    public static final String EXTRA_MY_USERNAME = "my_username";
    public static final String EXTRA_MY_RATING = "my_rating";

    // Not specified anywhere: long enough that a slow-but-fine connection doesn't
    // misfire, short enough that a genuinely dead socket doesn't strand the player.
    private static final long SEND_TIMEOUT_MS = 8000;

    private static final String TAG = "GameActivity";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private BoardView boardView;
    private EvalBarView evalBarView;
    private TextView opponentNameText;
    private TextView opponentRatingText;
    private TextView opponentClockText;
    private TextView myClockText;
    private TextView feedbackVerdictText;
    private TextView feedbackLossText;
    private Button resignButton;
    // Guards against an out-of-order move.feedback (the engine answers async,
    // so a later ply's verdict can arrive before an earlier one's — see
    // evaluation.test.js's out-of-order cases) overwriting an already-shown
    // later verdict with a stale one. 0 means "nothing applied yet".
    private int lastAppliedFeedbackPly = 0;
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
        evalBarView = findViewById(R.id.evalBarView);
        opponentNameText = findViewById(R.id.opponentNameText);
        opponentRatingText = findViewById(R.id.opponentRatingText);
        opponentClockText = findViewById(R.id.opponentClockText);
        myClockText = findViewById(R.id.myClockText);
        feedbackVerdictText = findViewById(R.id.feedbackVerdictText);
        feedbackLossText = findViewById(R.id.feedbackLossText);
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
            // Only a feedback game ever shows this panel, and only once the
            // mode is actually known — the views stay GONE (no placeholder,
            // no layout space) for every other mode, including the no-
            // MatchFound manual-launch path where mode is never read at all.
            if ("feedback".equals(matchFound.mode)) {
                feedbackVerdictText.setVisibility(View.VISIBLE);
                feedbackLossText.setVisibility(View.VISIBLE);
                feedbackVerdictText.setText(R.string.feedback_placeholder);
                feedbackVerdictText.setTextColor(getColor(R.color.feedback_neutral));
            }
            // Same rule for the eval bar: only an eval game shows it. It starts
            // at 50/50 until the first eval.update, and is oriented like the
            // board — the local player's colour at the bottom.
            if ("eval".equals(matchFound.mode)) {
                evalBarView.setFlipped(!"white".equals(myColor));
                evalBarView.setVisibility(View.VISIBLE);
            }
            GameSocket.getInstance().setGameListener(new GameSocket.GameListener() {
                @Override
                public void onMoveCommitted(MoveCommitted event) {
                    runOnUiThread(() -> handleMoveCommitted(event));
                }

                @Override
                public void onMoveFeedback(MoveFeedback event) {
                    runOnUiThread(() -> handleMoveFeedback(event));
                }

                @Override
                public void onEvalUpdate(EvalUpdate event) {
                    // Stale/duplicate plies and the mate label's show/clear
                    // decision are the bar's own model's job (EvalBarModel).
                    runOnUiThread(() -> evalBarView.setEval(event.ply, event.evalCp, event.mateIn));
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

    private void handleMoveFeedback(MoveFeedback event) {
        // See lastAppliedFeedbackPly's own comment: a strictly-increasing ply
        // is what stops a late, earlier-move verdict from overwriting a
        // later one already on screen.
        if (event.ply <= lastAppliedFeedbackPly) {
            return;
        }
        lastAppliedFeedbackPly = event.ply;
        applyClassification(event.classification);
        feedbackLossText.setText(formatCpLoss(event.cpLoss));
    }

    // classification is server vocabulary that may grow (CLAUDE.md's `mode`
    // and classification-threshold decisions both call this out) — anything
    // not in this list still renders, raw and in a neutral colour, rather
    // than crashing or silently dropping the verdict.
    private void applyClassification(String classification) {
        int colorRes;
        String label;
        switch (classification) {
            case "best":
                colorRes = R.color.feedback_best;
                label = getString(R.string.feedback_verdict_best);
                break;
            case "good":
                colorRes = R.color.feedback_good;
                label = getString(R.string.feedback_verdict_good);
                break;
            case "inaccuracy":
                colorRes = R.color.feedback_inaccuracy;
                label = getString(R.string.feedback_verdict_inaccuracy);
                break;
            case "mistake":
                colorRes = R.color.feedback_mistake;
                label = getString(R.string.feedback_verdict_mistake);
                break;
            case "blunder":
                colorRes = R.color.feedback_blunder;
                label = getString(R.string.feedback_verdict_blunder);
                break;
            default:
                colorRes = R.color.feedback_neutral;
                label = classification;
                break;
        }
        feedbackVerdictText.setText(label);
        feedbackVerdictText.setTextColor(getColor(colorRes));
    }

    // cpLoss is a non-negative integer number of centipawns (server-side
    // contract, CW-147) — this is the one place it becomes pawns for display.
    // 0 reads as "0.00", not "-0.00": it is a loss of nothing, not a negative
    // amount.
    private static String formatCpLoss(int cpLoss) {
        if (cpLoss == 0) {
            return "0.00";
        }
        return String.format(Locale.US, "-%.2f", cpLoss / 100.0);
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

    // Back to the Home that launched this game — it is always the one directly
    // underneath, alive and waiting on its activity result, which is what makes
    // it refresh the rating and history. Starting a new HomeActivity here instead
    // would stack another Home per game and leave the refresh on the hidden one.
    private void goToHome() {
        setResult(RESULT_OK);
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
