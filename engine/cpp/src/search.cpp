#include "search.hpp"
#include <iostream>
#include <utility>
#include <algorithm>
namespace {

// Ordering values, deliberately NOT eval.cpp's. Ordering needs only the
// ranking, and sharing the numbers would mean a future evaluation tweak
// silently reorders the search.
//
// Indexed by chess.hpp's PieceType: PAWN 0 to KING 5, with NONE 6 so an empty
// square cannot read off the end. Small on purpose — Move::setScore takes an
// int16_t, and the textbook victim * 100 overflows on PxQ, wraps negative, and
// sorts captures LAST with nothing anywhere reporting it.
constexpr int ORDER[] = {1, 3, 3, 5, 9, 0, 0};   // P N B R Q K, none

// MVV-LVA: most valuable victim, least valuable attacker.
//
// The victim dominates and the attacker breaks ties, so PxQ is tried before
// QxQ — if the queen is defended the pawn capture still wins 800 where the
// queen capture only trades, which makes the cheap attacker the move more
// likely to be good. Quiet moves score 0 and keep the generator's order.
//
// This does not know whether a capture is sound: QxP onto a defended pawn still
// sorts above every quiet move. Knowing better is static exchange evaluation;
// this is the cheap approximation, and a losing capture is refuted immediately
// anyway, so it costs a few nodes rather than a wrong answer.
int orderScore(const Position& pos, Move m) {
    // En passant takes a pawn that is not on the destination square, so the
    // lookup below would score it as a quiet move.
    if (m.typeOf() == Move::ENPASSANT) return 10 * ORDER[0] - ORDER[0];

    const PieceType victim = pos.pieceAt(m.to().index()).type();
    if (victim == PieceType::NONE) return 0;

    const PieceType attacker = pos.pieceAt(m.from().index()).type();
    return 10 * ORDER[static_cast<int>(victim)] - ORDER[static_cast<int>(attacker)];
}

void orderMoves(const Position& pos, MoveList& moves) {
    for (Move& m : moves)
        m.setScore(static_cast<std::int16_t>(orderScore(pos, m)));
    // Stable: every quiet move scores 0, and reshuffling them differently at
    // each node would be churn with no information behind it.
    std::stable_sort(moves.begin(), moves.end(),
                     [](Move a, Move b) { return a.score() > b.score(); });
}

}  // namespace


//checks if time passed 
bool Searcher::outOfTime() {
    if (stop_) return true;
    if (!hasDeadline_) return false;
    if (std::chrono::steady_clock::now() >= deadline_) stop_ = true;
    return stop_;
}

void Searcher::report(const SearchResult& r) const {
    std::cout << "info depth " << r.depth;
    if (isMateScore(r.score)) {
        // Mate has no centipawn value, so it gets UCI's own encoding. The facade
        // reads this branch and clamps it to +-10000 — engine/facade/src/uci.js.
        std::cout << " score mate " << mateInMoves(r.score);
    } else {
        std::cout << " score cp " << r.score;
    }
    std::cout << " nodes " << r.nodes << "\n" << std::flush;
}

// Negamax with an alpha-beta window. alpha/beta are from the point of view of
// the side to move at THIS node, which is why the recursive call both negates
// and swaps them: this node's floor is the child's ceiling.
int Searcher::negamax(Position& pos, int depth, int ply, int alpha, int beta) {
    ++nodes_;
    // One clock read per CHECK_INTERVAL nodes; in between, this is a bool test.
    if ((nodes_ & (CHECK_INTERVAL - 1)) == 0) outOfTime();

    // Once stopping, every node on the stack returns immediately. The value
    // returned here is meaningless — safe only because search() discards the
    // entire aborted iteration.
    if (stop_) return 0;
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
    orderMoves(pos, moves);
    int best = -INF_SCORE;
    for (int i = 0; i < moves.size(); ++i) {
        const Move m = moves[i];
        pos.makeMove(m);
        // Negated: the child returns a score from the opponent's point of view,
        // and this node wants its own.
        const int score = -negamax(pos, depth - 1, ply + 1,-beta, -alpha);
        pos.unmakeMove(m);
         if (stop_) {
            return 0;
        }
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



// One complete search at a fixed depth. The root loop lives here so the
// fixed-depth baseline and every iteration of the deepening driver run through
// exactly the same code — otherwise the comparison between them would be
// measuring two implementations rather than two strategies.
//
// Assumes the position has at least one legal move; search() checks that.
SearchResult Searcher::searchDepth(Position& pos, int depth, Move previousBest) {
    SearchResult result;
    result.depth = depth;

    MoveList moves;
    pos.legalMoves(moves);
    orderMoves(pos, moves);
    // Search the previous iteration's best move first. This is the whole reason
    // iterative deepening pays for its re-searches: the move that was best at
    // depth d-1 is usually best at depth d, so it raises alpha on the very first
    // try and every sibling is then refuted against a tight window instead of a
    // wide one. Without this, the re-search is overhead with nothing bought.
    if (previousBest.move() != Move::NO_MOVE) {
        // From 1: if it is already first, there is nothing to do.
        for (int i = 1; i < moves.size(); ++i) {
            if (moves[i].move() == previousBest.move()) {
                std::swap(moves[0], moves[i]);
                break;
            }
        }
    }
    // the root's window starts wide open. alpha rises as better moves are found,
    // which is what narrows the windows the children are searched with — the
    // root itself never cuts, because there is no parent that could have avoided
    // this position.
    int best = -INF_SCORE;
    int alpha = -INF_SCORE;

    for (int i = 0; i < moves.size(); ++i) {
        const Move m = moves[i];
        pos.makeMove(m);
        const int score = -negamax(pos, depth - 1, 1, -INF_SCORE, -alpha);
        pos.unmakeMove(m);
        // Abandoned mid-iteration: best and result.best are garbage from here on,
        // which is safe only because the caller throws this whole result away.
        if (stop_) break;
        if (score > best) {
            best = score;
            result.best = m;
        }
        if (cfg_.alphaBeta && best > alpha) alpha = best;
    }
    result.score = best;
    result.nodes = nodes_;   // cumulative across iterations, by design
    return result;
}


    
    
    
    




SearchResult Searcher::search(Position& pos, SearchLimits limits){
    //initializng number of nodes 
    nodes_ = 0;
    //not time for stop
    stop_ = false;
    // if not mentioned doesnt have deadline 
    hasDeadline_ = false;
    // A depth-0 search has no move to return, so there is no useful way to
    // honour the request. MAX_PLY at the top is what lets negamax skip a
    // ply-overflow guard: ply never gets past depth.
    int maxDepth = limits.maxDepth;
    if (maxDepth < 1) maxDepth = 1;
    if (maxDepth > MAX_PLY) maxDepth = MAX_PLY;

    SearchResult result;

    // Checked here rather than inside searchDepth, for two reasons: searchDepth
    // can then assume it has moves, and a terminal position reports exactly one
    // score line instead of one per iteration. That line is not optional — the
    // facade rejects an answer that arrives with no score at all.
    MoveList moves;
    pos.legalMoves(moves);
    if (moves.empty()) {
        result.score = pos.inCheck() ? -MATE_SCORE : 0;
        report(result);          // depth 0, nodes 0 — no search happened
        return result;
    }
    // Fixed depth: one search, generator order, no clock. Deliberately untimed —
    // an abandoned fixed-depth search has no earlier iteration to fall back on,
    // so its only possible answer would be "bestmove 0000".
    if (!cfg_.iterativeDeepening) {
        result = searchDepth(pos, maxDepth, Move::NO_MOVE);
        report(result);
        return result;
    }

    // we do iterative with potenatialy timing
    const bool timed = limits.budgetMs > 0;
    const auto start = std::chrono::steady_clock::now();
    const auto budget = std::chrono::milliseconds(limits.budgetMs);
    // Meaningless when untimed, and never read then — hasDeadline_ gates it.
    deadline_ = start + budget;

    Move previousBest = Move::NO_MOVE;

    for (int depth = 1; depth <= maxDepth; ++depth) {
        // Depth 1 is never abandoned. A budget small enough to expire inside the
        // first iteration must still produce a legal move — "bestmove 0000" in a
        // position with legal moves is a protocol violation the game server
        // cannot recover from — and depth 1 in a 30-move position is 30 nodes.
        hasDeadline_ = timed && depth > 1;

        const SearchResult current = searchDepth(pos, depth, previousBest);

        // An abandoned iteration changes nothing: the last completed depth's
        // answer stands, and the loop is over.
        if (stop_) break;

        previousBest = current.best;
        result = current;
        report(result);

        // if we found a mate that means we stopping 
        if (isMateScore(result.score)) break;
    }
    result.nodes = nodes_;
    return result;
}