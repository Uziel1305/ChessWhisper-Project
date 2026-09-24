package com.example.chesswhisper.data.game.model;

import java.io.Serializable;
import java.util.List;

// Mirrors the server's match.found payload field-for-field (GameManager.js's
// matchFound()). Passed whole to GameActivity, even though it only uses fen/
// legalMoves/clocks today — gameId/opponent are what CW-56 will need next.
public class MatchFound implements Serializable {
    public String gameId;
    public String color;
    // classic/eval/feedback/retraction — which assist features this game has.
    // GameActivity reads it once, at match.found, to decide which of the
    // eval bar / feedback panel (if either) to show; see CLAUDE.md's `mode`
    // decision. No enum yet — CW-155's picker is what introduces one.
    public String mode;
    public Opponent opponent;
    public String fen;
    public List<String> legalMoves;
    public long timeControlMs;
    public Clocks clocks;

    public static class Opponent implements Serializable {
        public String username;
        public int rating;
    }
}
