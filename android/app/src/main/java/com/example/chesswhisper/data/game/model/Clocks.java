package com.example.chesswhisper.data.game.model;

import java.io.Serializable;

// Shared shape for match.found's and move.committed's clocks field. Currently
// always null on the wire — CW-61's clock wiring didn't survive the merge with
// Uziel's moves-backend/opponent-move-instantly-backend PRs (see the "Merge
// resolution" note in the sprint plan); re-wiring it is a follow-up ticket.
public class Clocks implements Serializable {
    public long white;
    public long black;
}
