package com.example.chesswhisper.ui.home;

import androidx.annotation.Nullable;
import androidx.annotation.StringRes;

import com.example.chesswhisper.R;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

// Every mode the server knows — the one place Android names them. Each carries
// the exact wire value queue.join sends and games.mode stores (the server's own
// vocabulary, queue.js's MODES; anything else is answered with queue.rejected)
// and the label shown for it.
//
// retraction is known but not offered: the server accepts it, and game history
// can show it, but its assist feature isn't built, so offering it in the picker
// would put players in a game with no assist at all (CLAUDE.md, the `mode`
// decision). Anything iterating modes for the picker must use pickerModes(),
// never values().
public enum GameMode {
    CLASSIC("classic", R.string.mode_classic, true),
    EVAL("eval", R.string.mode_eval, true),
    FEEDBACK("feedback", R.string.mode_feedback, true),
    RETRACTION("retraction", R.string.mode_retraction, false);

    // What a fresh Home screen has selected.
    public static final GameMode DEFAULT = CLASSIC;

    public final String wireValue;
    @StringRes
    public final int labelRes;
    public final boolean offeredInPicker;

    GameMode(String wireValue, @StringRes int labelRes, boolean offeredInPicker) {
        this.wireValue = wireValue;
        this.labelRes = labelRes;
        this.offeredInPicker = offeredInPicker;
    }

    // The modes the Home picker shows, in the order it shows them.
    public static List<GameMode> pickerModes() {
        List<GameMode> modes = new ArrayList<>();
        for (GameMode mode : values()) {
            if (mode.offeredInPicker) modes.add(mode);
        }
        return Collections.unmodifiableList(modes);
    }

    // null for a mode this build doesn't know — the set grows as assist features
    // land, so an older app can meet a newer mode in its history. Callers show
    // the raw wire value then rather than failing.
    @Nullable
    public static GameMode fromWire(@Nullable String wireValue) {
        for (GameMode mode : values()) {
            if (mode.wireValue.equals(wireValue)) return mode;
        }
        return null;
    }
}
