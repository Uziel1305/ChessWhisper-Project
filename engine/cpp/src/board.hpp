#pragma once


#include <string>
#include <string_view>

#include "chess.hpp"


// The engine's own view of a position. Evaluation, search and the UCI loop go
// through this and never name a chess-library type directly.
//
// This header does include chess.hpp, deliberately. Hiding it completely (an
// opaque handle, or pimpl) would put an indirection into make/unmake, which the
// search calls millions of times per move. The discipline is in what this
// interface exposes, not in hiding the header from the compiler.

using Move = chess::Move;
using MoveList = chess::Movelist;


class Position {
public:
    // Default-constructs to the starting position.
    Position() = default;
    // set Fen position
    // False if the FEN could not be parsed. The library reports parse failure
    // but not legality, so an impossible-but-well-formed position still loads.
    bool setFen(std::string_view fen);
    std::string fen() const;

    void legalMoves(MoveList& out) const;

    void makeMove(Move m) { board_.makeMove(m); }
    // The library needs the same move object back — it reads the move type and
    // the captured piece out of it to restore state.
    void unmakeMove(Move m) { board_.unmakeMove(m); }

    bool inCheck() const { return board_.inCheck(); }
    bool whiteToMove() const { return board_.sideToMove() == chess::Color::WHITE; }

private:
    chess::Board board_;
};