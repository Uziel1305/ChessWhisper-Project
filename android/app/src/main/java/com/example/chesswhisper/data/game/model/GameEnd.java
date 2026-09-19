package com.example.chesswhisper.data.game.model;

// Server's game.end payload — the real shape, per GameManager.js's endGame():
// result is PGN notation ('1-0', '0-1', '1/2-1/2'), not a color/winner field.
// newRating/ratingDelta (CW-134) are this recipient's own values — GameManager
// sends a different payload to each socket now, not one shared object, since
// the two players' rating changes genuinely differ.
public class GameEnd {
    public String result;
    public String reason;
    public int newRating;
    public int ratingDelta;
}
