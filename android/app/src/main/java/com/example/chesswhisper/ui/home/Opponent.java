package com.example.chesswhisper.ui.home;

// Who the next game is against. Deliberately not a GameMode: a mode names the
// assist features both players agree on, while the opponent decides how the game
// starts — PLAYER through the matchmaking queue (queue.join), ENGINE at once with
// no queue (engine.start). Engine games are unrated and, for now, classic only.
public enum Opponent {
    PLAYER,
    ENGINE;

    // What a fresh Home screen has selected.
    public static final Opponent DEFAULT = PLAYER;
}
