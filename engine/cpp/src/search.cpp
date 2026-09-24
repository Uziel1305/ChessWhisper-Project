#include "search.hpp"

// Negamax with an alpha-beta window. alpha/beta are from the point of view of
// the side to move at THIS node, which is why the recursive call both negates
// and swaps them: this node's floor is the child's ceiling.
int Searcher::negamax(Position& pos, int depth, int ply, int alpha, int beta) {
    ++nodes_;

    MoveList moves;
    pos.legalMoves(moves);

    // Still tested before the depth cutoff, for the same reason as CW-117: a
    // checkmate sitting at the horizon must score as mate, not as material.

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
        const int score = -negamax(pos, depth - 1, ply + 1,-beta, -alpha);
        pos.unmakeMove(m);
        if (score > best) best = score;

        // With the toggle off, alpha never rises and the cutoff never fires, so
        // every child gets the full window and the node count is CW-117's
        // exactly. The test is constant for the whole search, so it is a
        // perfectly-predicted branch per move — the same argument that makes the
        // Evaluator's virtual call free.
        if (!cfg_.alphaBeta) continue;

        if (best > alpha) alpha = best;

        // Beta cutoff. The opponent, one ply up, already has a line at least as
        // good as beta, so they would never let this position happen. Whatever
        // this node's exact score turns out to be, it cannot change a decision
        // above it — so stop looking.
        if (alpha >= beta) break;
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

    // The root's window starts wide open. alpha rises as better moves are found,
    // which is what narrows the windows the children are searched with — the
    // root itself never cuts, because there is no parent that could have
    // avoided this position.
    int best = -INF_SCORE;
    int alpha = -INF_SCORE;
    for (int i = 0; i < moves.size(); ++i) {
        const Move m = moves[i];
        pos.makeMove(m);
        const int score = -negamax(pos, depth - 1, 1,-INF_SCORE, -alpha);
        pos.unmakeMove(m);
        if (score > best) {
            best = score;
            result.best = m;
        }
         if (cfg_.alphaBeta && best > alpha) alpha = best;
    }

    // best is untouched only when the loop never ran — no legal move, so
    // checkmate against us or stalemate. result.best stays NO_MOVE.
    result.score = moves.empty() ? (pos.inCheck() ? -MATE_SCORE : 0) : best;
    result.nodes = nodes_;
    return result;
}