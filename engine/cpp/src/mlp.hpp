#pragma once
#include <cstdint>
#include <string>
#include <vector>
#include "eval.hpp"

// The trained evaluator's weights, as ml/scripts/export_weights.py writes them.
//
// The format is deliberately generic across MLPs: the header carries the layer
// widths and the input mode, so this one loader reads a one-layer or a
// three-layer model, an embedding or a one-hot input, without a code change.
// Only a convolutional model would need something else.
//
// Everything here is validation. A weights file is a flat run of floats, and
// nothing about the bytes says whether they describe 256 units or 187 — so a
// file from a different model loads happily, runs at full speed, and returns
// confident nonsense that nothing downstream can detect. Every check below
// turns one of those into a refusal at startup.

// What this engine's encoder implements. These mirror ml/scripts/encode.py and
// are not configurable: a file describing anything else needs a different
// encoder, not a different number here.
inline constexpr std::uint32_t kSquares = 64;
inline constexpr std::uint32_t kCategories = 13;   // empty, 6 white, 6 black
inline constexpr std::uint32_t kFlagCount = 5;     // side to move, then K Q k q

struct MlpLayer {
    std::uint32_t in = 0;
    std::uint32_t out = 0;
    std::vector<float> weight;   // out x in, row-major — PyTorch's own layout
    std::vector<float> bias;     // out
};

struct MlpWeights {
    std::uint32_t categories = 0;
    std::uint32_t embedDim = 0;    // 0 means the input is one-hot
    std::uint32_t squares = 0;
    std::uint32_t flagCount = 0;
    std::uint32_t inputSize = 0;
    std::uint32_t scaleS = 0;      // the inverse transform is scaleS * sinh(y)
    std::uint32_t clampCp = 0;     // clamp before returning, below the mate band
    std::vector<float> embedding;  // categories x embedDim (empty when one-hot)
    std::vector<MlpLayer> hidden;
    MlpLayer out;
};

// Throws std::runtime_error naming the mismatch. Rejecting at load is the whole
// point: the alternative is an evaluator that works and is wrong.
MlpWeights loadMlpWeights(const std::string& path);


// The categories that are not "empty". chess.hpp's Piece::underlying runs
// WHITEPAWN = 0 to BLACKKING = 11 with NONE = 12, which is encode.py's
// categories minus one — exactly why encode.py chose P N B R Q K with White
// first. The port needs no translation table, only a +1.
inline constexpr std::uint32_t kPieceCount = 12;

// The trained evaluator. Returns centipawns from the side to move's point of
// view, like every other Evaluator: the dataset's targets are side-to-move
// relative too (ml/scripts/canonical.py), so nothing is flipped anywhere.
class MlpEvaluator : public Evaluator {
   public:
    // Throws if the file is missing, malformed, or describes another encoding.
    explicit MlpEvaluator(const std::string& path);

    int evaluate(const Position& pos) const override;
    const char* name() const override { return "mlp"; }

   private:
    MlpWeights weights_;
    std::uint32_t width_ = 0;     // the first hidden layer's width
    std::vector<float> base_;     // width_       : bias + a wholly empty board
    std::vector<float> table_;    // 64*12*width_ : what a piece changes
    std::vector<float> flags_;    // 5*width_     : the binary inputs' columns
};