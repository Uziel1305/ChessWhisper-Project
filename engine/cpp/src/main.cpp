
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
    // What the live evaluator was built from. Held because the two options that
    // determine it arrive in either order: a GUI may send EvalFile after Eval,
    // and "mlp with no path yet" has to become "mlp with a path" without the
    // engine ever holding a null evaluator.
    //
    // Relative to the engine's working directory, which in the image is the
    // directory the binary and the weights are copied into.
    std::string evalFile = "model6_run13.weights";
    std::string evalName = "mlp";
    // The live evaluator, and it is never null. mlp is the default, so startup
    // has to survive the weights being absent — a UCI engine that dies before
    // "uciok" tells a GUI nothing at all. The fallback is logged, and the
    // handshake prints its default from evalName, so what it declares is what is
    // actually live rather than what was intended.
    std::unique_ptr<Evaluator> evaluator = makeEvaluator(evalName, evalFile);
    if (!evaluator) {
        std::cerr << "falling back to material: the mlp weights did not load\n";
        evalName = "material";
        evaluator = makeEvaluator(evalName);
    }

    const auto applyEvaluator = [&] {
        if (auto next = makeEvaluator(evalName, evalFile)) {
            evaluator = std::move(next);
            return true;
        }
        return false;
    };
    
    
    
    // The depth ceiling for an untimed search, and the fallback when a go command
    // names neither a depth nor a budget. Settable so one binary runs at several
    // depths from a fastchess config without a rebuild.
    int depth = 4;
    // The search's feature toggles. Held here, next to the evaluator, because
    // both are "what the engine is configured as" and both are set by
    // setoption — depth stays separate because it is what a single search was
    // asked for, not what the engine is.
    SearchConfig config;
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
            cout<<"option name Eval type combo default "<<evalName
                <<" var material var mlp var blend\n";
            cout<<"option name EvalFile type string default "<<evalFile<<"\n";
            cout<<"option name Depth type spin default 4 min 1 max "<<MAX_PLY<<"\n";
            cout<<"option name AlphaBeta type check default true\n";
            cout<<"option name IterativeDeepening type check default true\n";
            cout << "uciok\n";
            cout.flush();
        } else if (token == "setoption") {
            // setoption name <id> [value <x>]. Our option names contain no
            // spaces, so one token is enough for the name.
            string word, name, value;
            while (iss >> word) {
                if (word == "name") iss >> name;
                else if (word == "value") {
                    // The remainder of the line, trimmed. Every option but
                    // EvalFile has a single-token value, so this costs them
                    // nothing — and EvalFile stops breaking on a path with a
                    // space in it, which this repository's own path has.
                    std::getline(iss, value);
                    const auto first = value.find_first_not_of(" \t");
                    const auto last = value.find_last_not_of(" \t\r");
                    value = (first == string::npos) ? "" : value.substr(first, last - first + 1);
                }
            }
            if (name == "Eval") {
                // Only swap on success — an unrecognised value, or a weights
                // file that will not load, must not leave the engine holding no
                // evaluator at all.
                const string previous = evalName;
                evalName = value;
                if (!applyEvaluator()) {
                    evalName = previous;
                    std::cerr << "unknown Eval value: " << value << "\n";
                }
            } else if (name == "EvalFile") {
                const string previous = evalFile;
                evalFile = value;
                // Only reloads when the MLP is the live evaluator. Setting the
                // path while running material is a GUI stating a default, not a
                // request to switch.
                if ((evalName == "mlp" || evalName == "blend") && !applyEvaluator()) {
                    evalFile = previous;
                    std::cerr << "keeping the previous weights file\n";
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
            } else if (name == "AlphaBeta") {
                // A check option's value is exactly "true" or "false". Anything
                // else is a hand-typed mistake, and silently treating it as
                // false would mean an unexplained 10x slowdown.
                if (value == "true") {
                    config.alphaBeta = true;
                }else if (value == "false") {
                    config.alphaBeta = false;
                }else{
                    std::cerr << "bad AlphaBeta value: " << value << "\n";
                } 
            } else if (name == "IterativeDeepening") {
                if (value == "true") config.iterativeDeepening = true;
                else if (value == "false") config.iterativeDeepening = false;
                else std::cerr << "bad IterativeDeepening value: " << value << "\n";
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
            // movetime is the only clock form we honour. wtime/btime/winc and
            // "infinite" are ignored — we do no clock management of our own, and
            // the facade only ever sends movetime (engine/facade/src/uci.js).
            // 0 means no budget, which keeps a bare "go" reproducible.
            int movetimeMs = 0;
            // 0 means this go command did not name a depth.
            int goDepth = 0;
            
            std::string opt;
            while (iss >> opt) {
                if (opt == "movetime") {
                    iss >> movetimeMs;
                } else if (opt == "depth") {
                    iss >> goDepth;
                }
            }
            SearchLimits limits;
            // An explicit "go depth N" wins. Otherwise a time budget means the
            // clock is the only limit, which is what "go movetime" means in UCI —
            // capping it at the Depth option would throw away depth the budget
            // had already paid for. With no budget at all, the Depth option is
            // the limit, which is what makes a bare "go" terminate.
            limits.maxDepth = goDepth > 0 ? goDepth
                                          : (movetimeMs > 0 ? MAX_PLY : depth);
            limits.budgetMs = movetimeMs;

            std::cout << "info string eval " << evaluator->name()
                      << " alphabeta " << (config.alphaBeta ? "true" : "false")
                      << " id " << (config.iterativeDeepening ? "true" : "false")
                      << "\n";
            // A fresh Searcher per go. It owns the node counter, the deadline and
            // the stop flag; nothing survives between searches, so there is
            // nothing worth reusing.
            Searcher searcher(*evaluator, config);
            const SearchResult r = searcher.search(pos, limits);

            // r.nodes is the total INCLUDING an iteration the clock abandoned, so
            // it can exceed the last "info depth" line's count. That difference is
            // the work thrown away — the number the half-budget cutoff is tuned
            // against.
            std::cout << "info string nodes " << r.nodes
                      << " completed depth " << r.depth << "\n";
            std::cout << "bestmove "
                      << (r.best.move() == Move::NO_MOVE ? "0000" : pos.toUci(r.best))
                      << "\n" << std::flush;

        }   else if (token == "quit") {
            break;
        }
    }
    return 0;
}


