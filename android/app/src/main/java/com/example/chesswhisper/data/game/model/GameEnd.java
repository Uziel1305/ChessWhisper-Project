package com.example.chesswhisper.data.game.model;

// Server's game.end payload — the real shape, per GameManager.js's endGame():
// result is PGN notation ('1-0', '0-1', '1/2-1/2'), not a color/winner field.
public class GameEnd {
    public String result;
    public String reason;
}
