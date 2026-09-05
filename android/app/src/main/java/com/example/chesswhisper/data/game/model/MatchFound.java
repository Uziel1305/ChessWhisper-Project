package com.example.chesswhisper.data.game.model;

import java.io.Serializable;
import java.util.List;

// Mirrors the server's match.found payload field-for-field (GameManager.js's
// matchFound()). Passed whole to GameActivity, even though it only uses fen/
// legalMoves today — gameId/color/opponent are what CW-56/CW-65 will need next.
public class MatchFound implements Serializable {
    public String gameId;
    public String color;
    public Opponent opponent;
    public String fen;
    public List<String> legalMoves;
    public long timeControlMs;
    // clocks intentionally left unmapped — null until CW-61.

    public static class Opponent implements Serializable {
        public String username;
        public int rating;
    }
}
