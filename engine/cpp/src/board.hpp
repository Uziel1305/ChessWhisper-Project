#pragma once
#include <optional>

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
using PieceType = chess::PieceType;
using Color = chess::Color;
using Piece = chess::Piece;

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

    // UCI conversion lives here so nothing outside this wrapper ever names
    // chess::uci. Castling is the reason these must be used rather than
    // building the string from from()/to(): the library stores castling as
    // king-takes-own-rook (e1h1), and UCI expects e1g1.
    std::string toUci(Move m) const;

    // nullopt if the string is malformed. This checks syntax, not legality —
    // "e2e5" parses cleanly from the starting position.
    std::optional<Move> fromUci(std::string_view uci) const;
    
    void makeMove(Move m) { board_.makeMove(m); }
    // The library needs the same move object back — it reads the move type and
    // the captured piece out of it to restore state.
    void unmakeMove(Move m) { board_.unmakeMove(m); }

    bool inCheck() const { 
        return board_.inCheck(); 
    }
    bool whiteToMove() const { 
        return board_.sideToMove() == chess::Color::WHITE; 
    }
    // Piece counts, for material evaluation.
    int count(PieceType pt, Color c) const { 
        return board_.pieces(pt, c).count(); 
    }
    // The piece on a square, for evaluations that need square information.
    Piece pieceAt(int sq) const { 
        return board_.at(sq); 
    }

private:
    chess::Board board_;
};