
#include "board.hpp"
#include <iostream>
#include <memory>
#include <sstream>
#include <string>
#include <utility>
#include "eval.hpp"
#include "search.hpp"
using namespace std;


int main(){
    string line;
    //holds the position of the game
    Position pos;
    // The live evaluator. Matches the option's declared default below, and is
    // never null — "material" is a name makeEvaluator knows.
    std::unique_ptr<Evaluator> evaluator = makeEvaluator("material");
    // Fixed depth until CW-119 makes the search time-bounded. Settable so one
    // binary can be run at several depths from a fastchess config without a
    // rebuild — the same reason the evaluator is an option.
    int depth = 4;
    while (getline(cin,line)){
        istringstream iss(line);
        string token;
        iss>>token;

        if(token=="uci"){
            //uci handshake
            cout<<"id name ChessWhisper Engine\n";
            cout<<"id author Uziel & Tamir\n";
            // Declared so a GUI can offer it and, more importantly, reject a
            // misspelled value instead of silently running the default. More
            // variants get added here as evaluators land.
            cout<<"option name Eval type combo default material var material\n";
            cout<<"option name Depth type spin default 4 min 1 max "<<MAX_PLY<<"\n";
            cout << "uciok\n";
            cout.flush();
        } else if (token == "setoption") {
            // setoption name <id> [value <x>]. Our option names and values
            // contain no spaces, so one token each is enough.
            string word, name, value;
            while (iss >> word) {
                if (word == "name") iss >> name;
                else if (word == "value") iss >> value;
            }
            if (name == "Eval") {
                // Only swap on success — an unrecognised value must not leave
                // the engine holding no evaluator at all.
                if (auto next = makeEvaluator(value)) {
                    evaluator = std::move(next);
                } else {
                    std::cerr << "unknown Eval value: " << value << "\n";
                }
            }else if (name == "Depth") {
                std::istringstream vs(value);
                int d = 0;
                // A GUI honours the min/max it was told, a hand-typed command
                // does not, and the searcher clamps regardless — so this only
                // has to reject what isn't a number at all.
                if (vs >> d) {
                    depth = d;
                }else {
                    std::cerr << "bad Depth value: " << value << "\n";
                }
            } else {
                std::cerr << "unknown option: " << name << "\n";
            }
        } else if (token == "isready") {
            std::cout << "readyok\n";
            cout.flush();
        } else if (token == "position") {
            std::string sub;
            iss >> sub;
            bool sawMoves = false;

            if (sub == "startpos") {
                //insert the initial position
                //resets the position
                pos = Position{};
            } else if (sub == "fen") {
                std::string fen, part;
                while (iss >> part) {
                    if (part == "moves") { 
                        sawMoves = true; 
                        break; 
                    }
                    if (!fen.empty()){
                        fen += ' ';
                    } 
                    fen += part;
                }
                // A bad FEN would otherwise leave the previous position loaded
                // and silently evaluate the wrong board. UCI has no way to
                // report this, so stderr is the only signal there is.
                if (!pos.setFen(fen)){
                    std::cerr << "bad fen: " << fen << "\n";
                }     
            }

            if (!sawMoves) {
                std::string part;
                //in the case of startpos
                if (iss >> part && part == "moves") {
                    sawMoves = true;
                }
            }
            if (sawMoves) {
                std::string uci;
                while (iss >> uci) {
                    if (const auto m = pos.fromUci(uci)) {
                        // m is optional<Move>
                        pos.makeMove(*m);
                    }
                }
            }
        }else if (token == "go") {
            // movetime is parsed now, consumed at CW-119 when iterative
            // deepening needs a deadline. depth/wtime/infinite are ignored —
            // the facade only ever sends movetime.
            int movetimeMs = 200;
            // "go depth N" overrides the option for this one search, which is
            // what UCI means by it — and it's the convenient way to test by
            // hand. The option stays whatever it was.
            int goDepth = depth;
            std::string opt;
            while (iss >> opt) {
                if (opt == "movetime") {
                    iss >> movetimeMs;
                } else if (opt == "depth") {
                    iss >> goDepth;
                }
            }

            // A fresh Searcher per go. It owns the node counter, and CW-119
            // gives it a deadline; nothing survives between searches yet, so
            // there is nothing worth reusing.
            Searcher searcher(*evaluator);
            const SearchResult r = searcher.search(pos, goDepth);

            std::cout << "info string eval " << evaluator->name() << "\n";

            std::cout << "info depth " << goDepth;
            if (isMateScore(r.score)) {
                // Mate has no centipawn value, so it gets UCI's own mate
                // encoding. The facade already reads this branch and clamps it
                // to +-10000 — see engine/facade/src/uci.js.
                std::cout << " score mate " << mateInMoves(r.score);
            } else {
                std::cout << " score cp " << r.score;
            }
            std::cout << " nodes " << r.nodes << "\n";

            // 0000 when the position has no legal move — the search found no
            // move because there is none. Whether that is mate or stalemate is
            // the game server's call, not the engine's.
            std::cout << "bestmove "
                      << (r.best.move() == Move::NO_MOVE ? "0000" : pos.toUci(r.best))
                      << "\n" << std::flush;

        }   else if (token == "quit") {
            break;
        }
    }
    return 0;
}


