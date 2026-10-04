#include "mlp.hpp"

#include <cstring>
#include <fstream>
#include <stdexcept>
#include <algorithm>
#include <cmath>
namespace {

constexpr char kMagic[4] = {'C', 'W', 'N', 'N'};
constexpr std::uint32_t kVersion = 1;
constexpr std::size_t kHeaderFields = 10;   // uint32s following the magic

[[noreturn]] void reject(const std::string& path, const std::string& why) {
    throw std::runtime_error("weights file " + path + " " + why);
}

}  // namespace

MlpWeights loadMlpWeights(const std::string& path) {
    std::ifstream file(path, std::ios::binary | std::ios::ate);
    if (!file) reject(path, "cannot be opened");

    const auto size = static_cast<std::size_t>(file.tellg());
    file.seekg(0);
    std::vector<char> raw(size);
    if (!file.read(raw.data(), static_cast<std::streamsize>(size)))
        reject(path, "could not be read to the end");

    const std::size_t fixed = sizeof(kMagic) + 4 * kHeaderFields;
    if (size < fixed) reject(path, "is shorter than its own header");
    if (std::memcmp(raw.data(), kMagic, sizeof(kMagic)) != 0)
        reject(path, "does not begin with CWNN, so it is not a weights file");

    // Little-endian, which is what the exporter writes and what x86 and ARM
    // both run. A big-endian host would read garbage here, and the magic is
    // where that would have to be caught.
    const auto field = [&](std::size_t index) {
        std::uint32_t value;
        std::memcpy(&value, raw.data() + sizeof(kMagic) + 4 * index, sizeof(value));
        return value;
    };

    if (field(0) != kVersion)
        reject(path, "is format version " + std::to_string(field(0)) +
                     ", and this build reads " + std::to_string(kVersion));

    MlpWeights weights;
    weights.categories = field(1);
    weights.embedDim   = field(2);
    weights.squares    = field(3);
    weights.flagCount  = field(4);
    weights.inputSize  = field(5);
    weights.scaleS     = field(6);
    weights.clampCp    = field(7);
    const std::uint32_t hiddenCount = field(8);
    const std::uint32_t totalFloats = field(9);

    if (weights.squares != kSquares || weights.categories != kCategories ||
        weights.flagCount != kFlagCount)
        reject(path, "describes an encoding this engine does not implement (" +
                     std::to_string(weights.squares) + " squares, " +
                     std::to_string(weights.categories) + " categories, " +
                     std::to_string(weights.flagCount) + " flags)");
    if (hiddenCount == 0) reject(path, "has no hidden layers");
    if (weights.scaleS == 0) reject(path, "has a scale of zero");

    const std::uint32_t expected =
        weights.embedDim ? weights.squares * weights.embedDim + weights.flagCount
                         : weights.squares * weights.categories + weights.flagCount;
    if (weights.inputSize != expected)
        reject(path, "claims an input of " + std::to_string(weights.inputSize) +
                     " where its own encoding gives " + std::to_string(expected));

    std::vector<std::uint32_t> widths(hiddenCount);
    std::memcpy(widths.data(), raw.data() + fixed, 4 * hiddenCount);

    std::size_t at = fixed + 4 * hiddenCount;
    if (size != at + 4ull * totalFloats)
        reject(path, "declares " + std::to_string(totalFloats) +
                     " floats but is " + std::to_string(size) + " bytes");

    const auto take = [&](std::size_t count) {
        std::vector<float> values(count);
        std::memcpy(values.data(), raw.data() + at, 4 * count);
        at += 4 * count;
        return values;
    };

    // The order the exporter writes, and it is the only thing holding the two
    // sides together: embedding, then each hidden layer's weight and bias, then
    // the output layer's. Swapping any two of these reads real numbers into the
    // wrong places and still "works".
    if (weights.embedDim)
        weights.embedding = take(static_cast<std::size_t>(weights.categories) *
                                 weights.embedDim);

    std::uint32_t in = weights.inputSize;
    for (const std::uint32_t width : widths) {
        MlpLayer layer;
        layer.in = in;
        layer.out = width;
        layer.weight = take(static_cast<std::size_t>(width) * in);
        layer.bias = take(width);
        weights.hidden.push_back(std::move(layer));
        in = width;
    }
    weights.out.in = in;
    weights.out.out = 1;
    weights.out.weight = take(in);
    weights.out.bias = take(1);

    if (at != size) reject(path, "has trailing bytes after the last layer");
    return weights;
}

// ---------------------------------------------------------------------------
// The folding. The embedding makes every input non-zero, including empty
// squares, so the naive first layer is a dense 517 x 256 product — about
// 132,000 operations, which costs roughly two plies of search depth. But the
// empty-square contribution is a constant and separates out exactly:
//
//   sum over all squares of Ws.E[p]
//     = [ sum over all squares of Ws.E[0] ] + sum over OCCUPIED of Ws.(E[p]-E[0])
//
// The left term is precomputed once into base_; the right is 32-ish vector adds
// out of table_. Same weights, same result, about 9,700 operations.
//
// It works unchanged for a one-hot model, where "Ws.E[c]" is just the column
// W[:, 64c + s] — which is why the table is built through one accessor below
// rather than two code paths.
MlpEvaluator::MlpEvaluator(const std::string& path)
    : weights_(loadMlpWeights(path)) {
    const MlpLayer& first = weights_.hidden.front();
    width_ = first.out;

    // What category `category` on square `sq` contributes to the first layer.
    const auto contribution = [&](std::uint32_t sq, std::uint32_t category,
                                  std::vector<float>& out) {
        out.assign(width_, 0.0f);
        if (weights_.embedDim) {
            const float* vector =
                &weights_.embedding[static_cast<std::size_t>(category) * weights_.embedDim];
            for (std::uint32_t unit = 0; unit < width_; ++unit) {
                const float* row = &first.weight[static_cast<std::size_t>(unit) * first.in +
                                                 static_cast<std::size_t>(sq) * weights_.embedDim];
                float sum = 0.0f;
                for (std::uint32_t d = 0; d < weights_.embedDim; ++d)
                    sum += row[d] * vector[d];
                out[unit] = sum;
            }
        } else {
            const std::size_t column =
                static_cast<std::size_t>(sq) * weights_.categories + category;
            for (std::uint32_t unit = 0; unit < width_; ++unit)
                out[unit] = first.weight[static_cast<std::size_t>(unit) * first.in + column];
        }
    };

    base_.assign(first.bias.begin(), first.bias.end());
    table_.assign(static_cast<std::size_t>(kSquares) * kPieceCount * width_, 0.0f);

    std::vector<float> empty, occupied;
    for (std::uint32_t sq = 0; sq < kSquares; ++sq) {
        contribution(sq, 0, empty);                       // category 0 is empty
        //empty is the value for no piece in square sq
        for (std::uint32_t unit = 0; unit < width_; ++unit) {
            base_[unit] += empty[unit];
        }
        for (std::uint32_t piece = 0; piece < kPieceCount; ++piece) {
            contribution(sq, piece + 1, occupied);
            float* destination =
                &table_[(static_cast<std::size_t>(sq) * kPieceCount + piece) * width_];
            for (std::uint32_t unit = 0; unit < width_; ++unit)
                destination[unit] = occupied[unit] - empty[unit];
        }
    }

    // The five binary inputs sit at the end of the input vector, in the order
    // encode.py pins: side to move, then White kingside, White queenside,
    // Black kingside, Black queenside.
    flags_.assign(static_cast<std::size_t>(kFlagCount) * width_, 0.0f);
    const std::size_t at = weights_.inputSize - kFlagCount;
    for (std::uint32_t flag = 0; flag < kFlagCount; ++flag)
        for (std::uint32_t unit = 0; unit < width_; ++unit)
            flags_[static_cast<std::size_t>(flag) * width_ + unit] =
                first.weight[static_cast<std::size_t>(unit) * first.in + at + flag];
}


int MlpEvaluator::evaluate(const Position& pos) const {
    // Reused across calls rather than allocated per node: search calls this
    // millions of times a move, and a malloc in that path costs more than the
    // arithmetic does. assign() keeps the capacity after the first call.
    thread_local std::vector<float> accumulator, next;
    accumulator.assign(base_.begin(), base_.end());

    const auto add = [&](const float* column) {
        for (std::uint32_t unit = 0; unit < width_; ++unit) {
            accumulator[unit] += column[unit];
        }
    };

    for (std::uint32_t sq = 0; sq < kSquares; ++sq) {
        const int piece = static_cast<int>(pos.pieceAt(static_cast<int>(sq)).internal());
        if (piece >= static_cast<int>(kPieceCount)) continue;      // 12 is NONE
        add(&table_[(static_cast<std::size_t>(sq) * kPieceCount + piece) * width_]);
    }

    if (pos.whiteToMove())                        {
        add(&flags_[0 * width_]);
    }
    if (pos.canCastleKingSide(Color::WHITE))      {
        add(&flags_[1 * width_]);
    }
    if (pos.canCastleQueenSide(Color::WHITE))     {
        add(&flags_[2 * width_]);
    }
    if (pos.canCastleKingSide(Color::BLACK))      {
        add(&flags_[3 * width_]);
    }
    if (pos.canCastleQueenSide(Color::BLACK))     {
        add(&flags_[4 * width_]);
    }

    for (float& value : accumulator) value = value > 0.0f ? value : 0.0f;   // ReLU

    // Any further hidden layers are small and dense — no folding applies, and
    // at these widths none is wanted.
    for (std::size_t index = 1; index < weights_.hidden.size(); ++index) {
        const MlpLayer& layer = weights_.hidden[index];
        next.assign(layer.out, 0.0f);
        for (std::uint32_t out = 0; out < layer.out; ++out) {
            const float* row = &layer.weight[static_cast<std::size_t>(out) * layer.in];
            float sum = layer.bias[out];
            for (std::uint32_t in = 0; in < layer.in; ++in) sum += row[in] * accumulator[in];
            next[out] = sum > 0.0f ? sum : 0.0f;
        }
        accumulator.swap(next);
    }

    float y = weights_.out.bias.front();
    for (std::uint32_t in = 0; in < weights_.out.in; ++in)
        y += weights_.out.weight[in] * accumulator[in];

    // The exact inverse of the training transform, then the clamp. The clamp is
    // load-bearing: isMateScore in search.hpp treats anything past 29,936 as a
    // proven mate and stops deepening, and a regression head is not bounded by
    // the range of its targets — model6's largest validation output was 24,357.
    const double centipawns = static_cast<double>(weights_.scaleS) *
                              std::sinh(static_cast<double>(y));
    const double limit = static_cast<double>(weights_.clampCp);
    return static_cast<int>(std::lround(std::clamp(centipawns, -limit, limit)));
}
