package com.example.chesswhisper.data.game.model;

// Server's eval.update payload (GameManager.js's publishEvaluation) — sent to
// both players in an eval-mode game, identical for each. Both values are from
// WHITE's perspective and are never re-signed for the local player's colour:
// evalCp +250 means White is ahead, mateIn 3 means White mates in 3 and -3 means
// Black does.
public class EvalUpdate {
    public int ply;
    // Centipawns, clamped to +-10000 by the engine facade for a forced mate.
    public int evalCp;
    // Present only when the engine found a forced mate; Gson leaves it null when
    // the key is absent, which is how a non-mate update arrives.
    public Integer mateIn;
}
