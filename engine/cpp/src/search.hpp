#pragma once
#include "board.hpp"
#include "eval.hpp"

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
constexpr int MATE_SCORE = 30000;

// The initial "worse than anything" value. Deliberately NOT INT_MIN: negamax
// negates the value it gets back, and -INT_MIN is undefined behaviour.
constexpr int INF_SCORE = 32000;

// Caps how deep a line can get, which is also what makes the mate-score test
// below unambiguous.
constexpr int MAX_PLY = 64;

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

struct SearchResult {
    // NO_MOVE when the position has no legal move at all — checkmate or
    // stalemate. The caller distinguishes them from the score, not from here.
    Move best = Move::NO_MOVE;
    int score = 0;
    long long nodes = 0;
};

// Search holds the evaluator by reference and never learns which
// implementation it is.
class Searcher {
public:
    Searcher(const Evaluator& eval) : eval_(eval) {}

    // pos is non-const because the search makes and unmakes moves on it. It is
    // left exactly as it was found — every makeMove has a matching unmakeMove
    // on every path out.
    SearchResult search(Position& pos, int depth);

private:
    int negamax(Position& pos, int depth, int ply);
    
    const Evaluator& eval_;
    long long nodes_ = 0;
};