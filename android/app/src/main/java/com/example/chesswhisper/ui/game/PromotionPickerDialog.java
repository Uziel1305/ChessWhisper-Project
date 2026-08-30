package com.example.chesswhisper.ui.game;

import android.content.Context;
import android.view.LayoutInflater;
import android.view.View;
import android.widget.Button;

import androidx.appcompat.app.AlertDialog;

import com.example.chesswhisper.R;

import java.util.List;

// Shown when BoardView reports 4 legalMoves sharing a from/to (the e7e8q/r/b/n case).
// Purely a UI choice among candidates BoardView already computed — no chess rules here.
final class PromotionPickerDialog {

    interface OnChosenListener {
        void onChosen(String uci);
    }

    private PromotionPickerDialog() {
    }

    static void show(Context context, List<String> candidateUcis, OnChosenListener listener) {
        // UCI promotion letters are always lowercase regardless of color, so the
        // destination rank is what tells us which glyph color to draw.
        boolean white = candidateUcis.get(0).charAt(3) == '8';

        View view = LayoutInflater.from(context).inflate(R.layout.dialog_promotion_picker, null);
        AlertDialog dialog = new AlertDialog.Builder(context)
                .setTitle(R.string.promotion_picker_title)
                .setView(view)
                .create();

        bindButton(view, R.id.btnQueen, 'q', white, candidateUcis, dialog, listener);
        bindButton(view, R.id.btnRook, 'r', white, candidateUcis, dialog, listener);
        bindButton(view, R.id.btnBishop, 'b', white, candidateUcis, dialog, listener);
        bindButton(view, R.id.btnKnight, 'n', white, candidateUcis, dialog, listener);

        dialog.show();
    }

    private static void bindButton(View root, int buttonId, char promotionLetter, boolean white,
                                    List<String> candidateUcis, AlertDialog dialog,
                                    OnChosenListener listener) {
        String uci = candidateFor(candidateUcis, promotionLetter);
        char pieceChar = white ? Character.toUpperCase(promotionLetter) : promotionLetter;

        Button button = root.findViewById(buttonId);
        button.setText(BoardView.glyphFor(pieceChar));
        button.setOnClickListener(v -> {
            dialog.dismiss();
            listener.onChosen(uci);
        });
    }

    private static String candidateFor(List<String> candidateUcis, char promotionLetter) {
        for (String uci : candidateUcis) {
            if (uci.charAt(uci.length() - 1) == promotionLetter) {
                return uci;
            }
        }
        throw new IllegalStateException("no candidate for promotion letter " + promotionLetter);
    }
}
