package com.example.chesswhisper.ui.game;

import android.content.Context;
import android.view.LayoutInflater;
import android.view.View;
import android.widget.TextView;

import androidx.appcompat.app.AlertDialog;

import com.example.chesswhisper.R;

// Shown when a game ends. Mirrors Game.js's game.end payload shape ({winner, reason})
// directly rather than translating to "you win/you lose" — there's no concept of
// "which color am I" in the app yet (that arrives with match.found, CW-39/CW-41).
final class GameResultDialog {

    private GameResultDialog() {
    }

    static void show(Context context, String winner, String reason, Runnable onBackToHome) {
        View view = LayoutInflater.from(context).inflate(R.layout.dialog_game_result, null);

        String message = winner == null
                ? context.getString(R.string.game_result_draw, reason)
                : context.getString(R.string.game_result_win, capitalize(winner), reason);
        ((TextView) view.findViewById(R.id.resultMessage)).setText(message);

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

    private static String capitalize(String word) {
        return Character.toUpperCase(word.charAt(0)) + word.substring(1);
    }
}
