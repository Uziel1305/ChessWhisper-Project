package com.example.chesswhisper.data.game.model;

// Server's move.feedback payload (GameManager.js's classifyPly) — sent only to
// whoever made the move, never the opponent. cpLoss is a non-negative integer
// number of centipawns; GameActivity is the one place it becomes pawns for
// display, the server never sends a fractional value.
public class MoveFeedback {
    public int ply;
    public String classification;
    public int cpLoss;
}
