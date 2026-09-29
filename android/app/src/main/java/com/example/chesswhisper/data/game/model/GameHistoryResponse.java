package com.example.chesswhisper.data.game.model;

import java.util.Collections;
import java.util.List;

/**
 * Body of a successful GET /api/games/history response.
 *
 * No constructor, same as MeResponse: Gson fills these reflectively, so the
 * field names have to stay in sync with games.routes.js's { total, games }.
 */
public class GameHistoryResponse {
    // Every finished game, not just the ones in `games` — the server caps the
    // list, never the count.
    private int total;
    private List<GameSummary> games;

    public int getTotal() { return total; }

    // Never null, so the adapter needs no guard.
    public List<GameSummary> getGames() {
        return games == null ? Collections.emptyList() : games;
    }
}
