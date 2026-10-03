package com.example.chesswhisper.ui.game;

import android.content.Context;
import android.view.LayoutInflater;
import android.view.View;
import android.widget.TextView;

import androidx.appcompat.app.AlertDialog;

import com.example.chesswhisper.R;

// Shown when a game ends. Mirrors GameManager.js's real game.end payload shape —
// result is PGN notation ('1-0'/'0-1'/'1/2-1/2'), not a winner/color field — and
// still doesn't translate to "you win/you lose": there's no "which color am I"
// concept wired into this dialog, so it shows the raw outcome.
final class GameResultDialog {

    private GameResultDialog() {
    }

    // newRating/ratingDelta are null for an unrated game (against the engine),
    // and the rating line is then left out rather than shown as "0 (+0)".
    static void show(Context context, String result, String reason, Integer newRating,
            Integer ratingDelta, Runnable onBackToHome) {
        View view = LayoutInflater.from(context).inflate(R.layout.dialog_game_result, null);

        String message;
        if ("1/2-1/2".equals(result)) {
            message = context.getString(R.string.game_result_draw, reason);
        } else {
            String winner = "1-0".equals(result) ? "White" : "Black";
            message = context.getString(R.string.game_result_win, winner, reason);
        }
        ((TextView) view.findViewById(R.id.resultMessage)).setText(message);

        TextView ratingChangeText = view.findViewById(R.id.ratingChangeText);
        if (newRating == null || ratingDelta == null) {
            ratingChangeText.setVisibility(View.GONE);
        } else {
            // Explicit sign always, even for zero — "New rating: 1000 (+0)" reads
            // as "no change", where a bare "0" could be misread as truncation.
            String signedDelta = (ratingDelta >= 0 ? "+" : "") + ratingDelta;
            ratingChangeText.setText(
                    context.getString(R.string.game_result_rating_change, newRating, signedDelta));
        }

        AlertDialog dialog = new AlertDialog.Builder(context)
                .setTitle(R.string.game_over_title)
                .setView(view)
                .setCancelable(false)
                .create();

        view.findViewById(R.id.backToHomeButton).setOnClickListener(v -> {
            dialog.dismiss();
            onBackToHome.run();
        });

        dialog.show();
    }
}
