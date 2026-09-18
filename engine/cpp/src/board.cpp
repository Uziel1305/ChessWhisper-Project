#include "board.hpp"

bool Position::setFen(std::string_view fen) {
    return board_.setFen(fen);
}

std::string Position::fen() const {
    return board_.getFen();
}

void Position::legalMoves(MoveList& out) const {
    chess::movegen::legalmoves(out, board_);
}