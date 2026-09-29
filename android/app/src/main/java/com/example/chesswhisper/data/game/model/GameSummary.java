package com.example.chesswhisper.data.game.model;

/**
 * One finished game in GET /api/games/history, already seen from this player's
 * side: `color` is theirs, `opponent` is the other player, and `outcome`
 * ("win" / "loss" / "draw") was worked out by the server. The app never derives
 * it from the PGN result — that would be chess logic on the client.
 */
public class GameSummary {
    private String id;
    private String mode;
    private long timeControlMs;
    private String color;
    private String opponent;
    private String outcome;
    private String reason;
    // Boxed: the server sends null when the game has no rating_history row,
    // and "unknown" must not render as "+0".
    private Integer ratingDelta;
    private String endedAt;

    public String getId() { return id; }
    public String getMode() { return mode; }
    public long getTimeControlMs() { return timeControlMs; }
    public String getColor() { return color; }
    public String getOpponent() { return opponent; }
    public String getOutcome() { return outcome; }
    public String getReason() { return reason; }
    public Integer getRatingDelta() { return ratingDelta; }
    public String getEndedAt() { return endedAt; }
}
