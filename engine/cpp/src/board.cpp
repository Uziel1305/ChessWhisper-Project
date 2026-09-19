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

std::string Position::toUci(Move m) const {
    return chess::uci::moveToUci(m);
}

std::optional<Move> Position::fromUci(std::string_view uci) const {
    const Move m = chess::uci::uciToMove(board_, uci);
    if (m.move() == Move::NO_MOVE) {
        return std::nullopt;
    }
    return m;
}
