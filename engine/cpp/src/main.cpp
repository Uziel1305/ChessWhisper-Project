

#include <iostream>
#include <string>
using namespace std;


int main(){
    string line;
    while(getline(cin,line)){
        if(line=="uci"){
            //uci handshake
            cout<<"id name ChessWhisper Engine\n";
            cout<<"id author Uziel & Tamir\n";
            cout << "uciok\n";
            cout.flush();
        } else if (line == "quit") {
            break;
        }
        // Every other command (isready, position, go, ...) is ignored for
        // now — those arrive with the real UCI loop in CW-81/CW-82.
    }
    return 0;
}


// #include "board.hpp"
// #include <iostream>

// static bool roundTrip(const char* fen) {
//     Position pos;
//     if (!pos.setFen(fen)) {
//         std::cout << "FEN failed to parse: " << fen << "\n";
//         return false;
//     }
//     MoveList moves;
//     pos.legalMoves(moves);

//     bool ok = true;
//     for (const auto& m : moves) {
//         const std::string uci = pos.toUci(m);
//         const auto back = pos.fromUci(uci);
//         if (!back || *back != m) {
//             std::cout << "  round-trip failed: " << uci << "\n";
//             ok = false;
//         }
//     }
//     std::cout << (ok ? "ok   " : "FAIL ") << moves.size() << " moves  " << fen << "\n";
//     return ok;
// }

// int main() {
//     roundTrip("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
//     roundTrip("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
//     roundTrip("rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3");
//     roundTrip("8/4P3/8/8/8/8/8/K6k w - - 0 1");
//     return 0;
// }