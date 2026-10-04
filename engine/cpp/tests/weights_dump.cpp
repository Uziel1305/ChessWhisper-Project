#include <iomanip>
#include <iostream>

#include "mlp.hpp"

// Loads a weights file and prints what it found, so the loader can be checked
// against export_weights.py's own output before any evaluation code exists.
// Printing a few actual floats matters as much as the shapes: the shapes would
// still line up if the tensors were read in the wrong order.
//
// Given a FEN as well, it also evaluates it — which lets the evaluator be
// checked against ml/models/<run>_parity.csv before any UCI wiring exists, so a
// disagreement is one of two things rather than one of five.
int main(int argc, char** argv) {
    if (argc < 2 || argc > 3) {
        std::cerr << "usage: weights_dump <file.weights> [fen]\n";
        return 2;
    }
    try {
        const MlpWeights w = loadMlpWeights(argv[1]);
        std::size_t total = w.embedding.size();
        for (const auto& layer : w.hidden) total += layer.weight.size() + layer.bias.size();
        total += w.out.weight.size() + w.out.bias.size();

        std::cout << "input      " << w.inputSize
                  << (w.embedDim ? "  (embedding " + std::to_string(w.embedDim) + ")"
                                 : "  (one-hot)") << "\n";
        std::cout << "hidden     [";
        for (std::size_t i = 0; i < w.hidden.size(); ++i)
            std::cout << (i ? ", " : "") << w.hidden[i].out;
        std::cout << "]\n";
        std::cout << "floats     " << total << "\n";
        std::cout << "scale S    " << w.scaleS << "      clamp +-" << w.clampCp << " cp\n";

        std::cout << std::fixed << std::setprecision(6);
        const auto show = [](const char* label, const std::vector<float>& v,
                             std::size_t from) {
            std::cout << label;
            for (std::size_t i = from; i < from + 4 && i < v.size(); ++i)
                std::cout << "  " << v[i];
            std::cout << "\n";
        };
        if (w.embedDim) {
            show("embedding[0][:4] ", w.embedding, 0);
            show("embedding[12][:4]", w.embedding, 12ull * w.embedDim);
        }
        show("hidden W[0][:4]  ", w.hidden.front().weight, 0);
        show("hidden b[:4]     ", w.hidden.front().bias, 0);
        show("out W[0][:4]     ", w.out.weight, 0);
        std::cout << "out bias           " << w.out.bias.front() << "\n";

        if (argc == 3) {
            // Loads the file a second time, through the evaluator rather than
            // the loader. Wasteful and deliberate: it is the path the engine
            // will take, so this checks that path rather than a shortcut.
            const MlpEvaluator evaluator(argv[1]);
            Position position;
            if (!position.setFen(argv[2])) {
                std::cerr << "unparseable FEN: " << argv[2] << "\n";
                return 2;
            }
            std::cout << "\n" << argv[2] << "\n  "
                      << evaluator.evaluate(position) << " cp (side to move)\n";
        }
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "rejected: " << error.what() << "\n";
        return 1;
    }
}