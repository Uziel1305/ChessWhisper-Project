#include "search.hpp"

// Plain negamax: every node expands every legal move, with no pruning of any
// kind. That is the point of this version rather than a shortcoming of it —
// CW-118's alpha-beta has to reproduce these scores exactly while visiting far
// fewer nodes, and there is nothing to check it against unless one unpruned
// search exists.
int Searcher::negamax(Position& pos, int depth, int ply) {
    ++nodes_;

    MoveList moves;
    pos.legalMoves(moves);

    // Terminality is tested BEFORE the depth cutoff, and that ordering is the
    // entire reason mate detection works: at depth 0 the position may already
    // be checkmate, and returning a material score there would hide it behind
    // whatever pieces happen to be on the board. The cost is one move
    // generation at every leaf, paid deliberately.
    if (moves.empty()) {
        // Mated at this ply, or stalemate. -MATE_SCORE + ply rather than a flat
        // -MATE_SCORE, so a mate that arrives sooner scores higher than one
        // that arrives later.
        return pos.inCheck() ? -MATE_SCORE + ply : 0;
    }

    // <= 0 rather than == 0: search() calls in with depth - 1, so a depth-0
    // request would slip straight past an == test and recurse without end.
    if (depth <= 0) {
        return eval_.evaluate(pos);
    }

    int best = -INF_SCORE;
    for (int i = 0; i < moves.size(); ++i) {
        const Move m = moves[i];
        pos.makeMove(m);
        // Negated: the child returns a score from the opponent's point of view,
        // and this node wants its own.
        const int score = -negamax(pos, depth - 1, ply + 1);
        pos.unmakeMove(m);
        if (score > best) best = score;
    }
    return best;
}

SearchResult Searcher::search(Position& pos, int depth) {
    nodes_ = 0;
    // A depth-0 search has no move to return, so there is no useful way to
    // honour the request. MAX_PLY at the top is what lets negamax skip a
    // ply-overflow guard: ply never gets past depth.
    if (depth < 1) depth = 1;
    if (depth > MAX_PLY) depth = MAX_PLY;

    SearchResult result;
    MoveList moves;
    pos.legalMoves(moves);

    // The root loop is written out separately instead of reusing negamax,
    // because only the root needs to remember WHICH move produced the best
    // score. negamax returns a number and nothing else.
    int best = -INF_SCORE;
    for (int i = 0; i < moves.size(); ++i) {
        const Move m = moves[i];
        pos.makeMove(m);
        const int score = -negamax(pos, depth - 1, 1);
        pos.unmakeMove(m);
        if (score > best) {
            best = score;
            result.best = m;
        }
    }

    // best is untouched only when the loop never ran — no legal move, so
    // checkmate against us or stalemate. result.best stays NO_MOVE.
    result.score = moves.empty() ? (pos.inCheck() ? -MATE_SCORE : 0) : best;
    result.nodes = nodes_;
    return result;
}