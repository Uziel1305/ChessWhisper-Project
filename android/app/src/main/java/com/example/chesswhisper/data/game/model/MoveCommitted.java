package com.example.chesswhisper.data.game.model;

import java.util.List;

// Server's move.committed payload: the result of any player's move, applied
// identically on both sides. No gameId/color here — the socket already knows
// which game and the client already knows which color it is.
public class MoveCommitted {
    public String uci;
    public String fen;
    public List<String> legalMoves;
    public Clocks clocks;
}
