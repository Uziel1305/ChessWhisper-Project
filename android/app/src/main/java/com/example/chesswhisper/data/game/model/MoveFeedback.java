package com.example.chesswhisper.data.game.model;

// Server's move.feedback payload (GameManager.js's classifyPly) — sent only to
// whoever made the move, never the opponent. The server also sends cpLoss, which
// the app deliberately does not read: only the verdict label is shown.
// lostAdvantage is present on the wire only when true; Gson leaves it false when
// the key is absent.
public class MoveFeedback {
    public int ply;
    public String classification;
    public boolean lostAdvantage;
}
