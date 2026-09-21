#include "board.hpp"
#include <cstdint>
#include <iostream>

// No bulk counting at depth 1 (returning moves.size() without recursing).
// It would be ~5x faster, but this test exists to exercise make/unmake, and
// bulk counting skips exactly those calls at the leaves where most nodes are.
static std::uint64_t preft(Position& pos, int depth){
    if(depth==0){
        return 1;
    }
    MoveList moves;
    pos.legalMoves(moves);
    std::uint64_t nodes=0;
    for(const auto& m:moves){
        pos.makeMove(m);
        nodes+=preft(pos,depth-1);
        pos.unmakeMove(m);
    }
    return nodes;
}

static int failures = 0;


static void check(const char* name, const char* fen, int depth, std::uint64_t expected) {
    Position pos;
    if (!pos.setFen(fen)) {
        std::cout << "FAIL " << name << " d" << depth << ": FEN did not parse\n";
        ++failures;
        return;
    }
    const std::uint64_t got = preft(pos, depth);
    if (got == expected) {
        std::cout << "ok   " << name << " d" << depth << "  " << got << "\n";
    } else {
        std::cout << "FAIL " << name << " d" << depth
                  << "  expected " << expected << " got " << got << "\n";
        ++failures;
    }
}


// Re-homed from CW-96's throwaway probe: every legal move must survive
// toUci -> fromUci unchanged. Covers castling, en passant and promotions.
static void roundTrip(const char* name, const char* fen) {
    Position pos;
    if (!pos.setFen(fen)) {
        std::cout << "FAIL round-trip " << name << ": FEN did not parse\n";
        ++failures;
        return;
    }
    MoveList moves;
    pos.legalMoves(moves);

    bool ok = true;
    for (const auto& m : moves) {
        const auto back = pos.fromUci(pos.toUci(m));
        if (!back || *back != m) {
            std::cout << "  round-trip failed: " << pos.toUci(m) << "\n";
            ok = false;
        }
    }
    std::cout << (ok ? "ok   " : "FAIL ") << "round-trip " << name
              << "  " << moves.size() << " moves\n";
    if (!ok) ++failures;
}


int main() {
    const char* START    = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const char* KIWIPETE = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1";
    const char* POS3     = "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1";
    const char* POS4     = "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1";
    const char* POS5     = "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8";

    // CW-108
    check("start", START, 1, 20);
    check("start", START, 2, 400);
    check("start", START, 3, 8902);
    check("start", START, 4, 197281);
    check("start", START, 5, 4865609);

    // CW-109
    check("kiwipete", KIWIPETE, 1, 48);
    check("kiwipete", KIWIPETE, 2, 2039);
    check("kiwipete", KIWIPETE, 3, 97862);
    check("kiwipete", KIWIPETE, 4, 4085603);

    check("pos3", POS3, 4, 43238);
    check("pos3", POS3, 5, 674624);
    check("pos4", POS4, 4, 422333);
    check("pos5", POS5, 4, 2103487);

    roundTrip("start", START);
    roundTrip("kiwipete", KIWIPETE);
    roundTrip("promotion", "8/4P3/8/8/8/8/8/K6k w - - 0 1");

    if (failures) {
        std::cout << "\n" << failures << " FAILURES\n";
    } else {
        std::cout << "\nall passed\n";
    }
    return failures ? 1 : 0;
}