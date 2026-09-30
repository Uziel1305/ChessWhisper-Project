#pragma once
#include "board.hpp"
#include "eval.hpp"
#include <chrono>
// Scores are centipawns from the SIDE TO MOVE's perspective — the same
// convention Evaluator returns and UCI's "score cp" reports, so nothing
// downstream flips a sign.
//
// MATE_SCORE sits far above anything material evaluation can reach, so a forced
// mate always outranks any quantity of material.
//
// Mates are stored depth-aware: being mated at ply p scores -MATE_SCORE + p.
// That is what makes the search prefer mating in 1 over mating in 3, and prefer
// being mated in 5 over being mated in 1 — without it, every mate is the same
// number and the engine will happily sit on a mate it could have played two
// moves ago.
constexpr int MATE_SCORE = 40000;

// The initial "worse than anything" value. Deliberately NOT INT_MIN: negamax
// negates the value it gets back, and -INT_MIN is undefined behaviour.
constexpr int INF_SCORE = 42000;

// Caps how deep a line can get, which is also what makes the mate-score test
// below unambiguous.
constexpr int MAX_PLY = 64;
// Nodes between clock reads. steady_clock::now() costs tens of nanoseconds
// against an evaluation of a few hundred, which is nothing per node and real
// time across millions of them. A power of two so the test is a bit mask.
constexpr long long CHECK_INTERVAL = 2048;

// A score within MAX_PLY of MATE_SCORE can only have come from a mate line —
// the largest material evaluation reachable on a legal board is nowhere near it.
inline bool isMateScore(int score) {
    return score > MATE_SCORE - MAX_PLY || score < -MATE_SCORE + MAX_PLY;
}

// Moves (not plies) to mate, signed the way UCI's "score mate N" wants it:
// positive when the side to move delivers the mate, negative when it is
// delivered to them. Rounds up, because a mate delivered on ply 1 is mate in 1.
inline int mateInMoves(int score) {
    //making score absolute
    const int plies = MATE_SCORE - (score < 0 ? -score : score);
    const int moves = (plies + 1) / 2;
    return score > 0 ? moves : -moves;
}
// Search features are toggles on one searcher rather than subclasses, because
// they compose: alpha-beta, quiescence (CW-120) and move ordering (CW-121) are
// layers on the same recursion, not alternatives to it. Named fields rather
// than positional bools, so adding the next one cannot silently swap two
// arguments at a call site.
struct SearchConfig {
    // Off gives back the unpruned negamax of CW-117 — identical root score,
    // identical best move, an order of magnitude more nodes. That is the
    // reference the pruned search is verified against, which is why it stays
    // reachable at runtime.
    bool alphaBeta = true;

    // Off searches straight to the requested depth, in the move generator's own
    // order, with no clock — which is how a specific node count is reproduced
    // for comparison against CW-118's numbers. That mode has no earlier
    // iteration to fall back on if a deadline expired, so it is untimed by
    // construction and the facade must never run with it off.
    bool iterativeDeepening = true;
};

// The terms of one search, as against SearchConfig, which is what the engine is
// configured as. Iterative deepening runs depth 1, 2, 3 ... and stops at
// whichever of these two limits is reached first.
struct SearchLimits {
    int maxDepth = MAX_PLY;
    // Wall-clock budget in milliseconds. 0 means no budget at all: search to
    // maxDepth and take as long as that takes, which is what "go depth N" asks
    // for and what the verification steps need in order to be reproducible.
    int budgetMs = 0;
};

struct SearchResult {
    // NO_MOVE when the position has no legal move at all — checkmate or
    // stalemate. The caller distinguishes them from the score, not from here.
    Move best = Move::NO_MOVE;
    int score = 0;
    long long nodes = 0;
    // The deepest iteration that ran to COMPLETION. best and score come from
    // that iteration and no other. This is what "info depth" must print — the
    // depth asked for is not the depth searched, which is also what fixes
    // CW-117's wart where a clamped Depth of 99 still printed 99.
    int depth = 0;
};

// Search holds the evaluator by reference and never learns which
// implementation it is.
class Searcher {
public:
    Searcher(const Evaluator& eval, SearchConfig cfg = {})
        : eval_(eval), cfg_(cfg) {}

    // pos is non-const because the search makes and unmakes moves on it. It is
    // left exactly as it was found — every makeMove has a matching unmakeMove
    // on every path out.
      SearchResult search(Position& pos, SearchLimits limits);

private:
    // alpha is the score the side to move is already guaranteed somewhere else
    // in the tree; beta is the score at which the opponent, one ply up, would
    // never have allowed this position in the first place. A node whose score
    // reaches beta can stop immediately — its exact value can no longer change
    // any decision above it.
    int negamax(Position& pos, int depth, int ply, int alpha, int beta);
    // Sets and returns stop_. Sticky: once the search is unwinding, no further
    // clock reads happen.
    bool outOfTime();


    const Evaluator& eval_;
    SearchConfig cfg_;
    long long nodes_ = 0;
    // Wall clock, not CPU time. The deadline exists so the facade gets an answer
    // inside its HTTP timeout, and the facade is watching a wall clock.
    std::chrono::steady_clock::time_point deadline_{};
    bool hasDeadline_ = false;
    bool stop_ = false;
    // Prints one UCI "info depth ..." line. The search doing its own I/O is a
    // deliberate simplification over a callback: the cost is that a caller who
    // wants a silent search (a unit test, or the engine pool doing something
    // internal) can't have one, and the retrofit is this function's body.
    void report(const SearchResult& r) const;
    // One complete search at a fixed depth, from the root. Knows nothing about
    // iteration or the clock beyond honouring stop_.
    //
    // previousBest is the best move from the previous iteration, searched first.
    // NO_MOVE means there is no previous iteration — depth 1, or fixed-depth
    // mode — and the generator's own order stands, which is what keeps the
    // baseline reproducible.
    SearchResult searchDepth(Position& pos, int depth, Move previousBest);
};