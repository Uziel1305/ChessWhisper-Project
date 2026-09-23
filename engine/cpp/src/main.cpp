
#include "board.hpp"
#include <iostream>
#include <memory>
#include <sstream>
#include <string>
#include <utility>
#include "eval.hpp"
using namespace std;


int main(){
    string line;
    //holds the position of the game
    Position pos;
    // The live evaluator. Matches the option's declared default below, and is
    // never null — "material" is a name makeEvaluator knows.
    std::unique_ptr<Evaluator> evaluator = makeEvaluator("material");
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
            std::string opt;
            while (iss >> opt) {
                if (opt == "movetime") {
                    iss >> movetimeMs;
                }
            }

            // Placeholder: first legal move, no search and no score. CW-111
            // adds the info line; CW-82 replaces this with a real search.
            MoveList moves;
            pos.legalMoves(moves);
            // depth 1 because nothing searches yet — this is the static
            // evaluation of the current position. CW-117 onward gives the
            // number more behind it.
            // Which evaluator is actually live. A setoption that never applied
            // shows up here, rather than as quietly identical results.
            std::cout << "info string eval " << evaluator->name() << "\n";
            std::cout << "info depth 1 score cp " << evaluator->evaluate(pos) << "\n";
            std::cout << "bestmove "
                      << (moves.empty() ? "0000" : pos.toUci(moves[0]))
                      << "\n" << std::flush;

        }   else if (token == "quit") {
            break;
        }
    }
    return 0;
}


