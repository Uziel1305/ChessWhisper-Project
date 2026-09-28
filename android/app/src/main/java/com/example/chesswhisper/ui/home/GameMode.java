package com.example.chesswhisper.ui.home;

import androidx.annotation.StringRes;

import com.example.chesswhisper.R;

// The modes the Home picker offers — the one place Android names them. Each
// carries the exact wire value queue.join sends (the server's own vocabulary,
// queue.js's MODES; anything else is answered with queue.rejected) and the
// label the picker shows.
//
// retraction is deliberately absent: the server accepts it, but its assist
// feature isn't built, so offering it would put players in a game with no
// assist at all (CLAUDE.md, the `mode` decision).
public enum GameMode {
    CLASSIC("classic", R.string.mode_classic),
    EVAL("eval", R.string.mode_eval),
    FEEDBACK("feedback", R.string.mode_feedback);

    // What a fresh Home screen has selected.
    public static final GameMode DEFAULT = CLASSIC;

    public final String wireValue;
    @StringRes
    public final int labelRes;

    GameMode(String wireValue, @StringRes int labelRes) {
        this.wireValue = wireValue;
        this.labelRes = labelRes;
    }
}
