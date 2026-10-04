#include "eval.hpp"
#include "mlp.hpp"

namespace {

// Shared by every evaluator that scores material, so the values stay
// consistent as implementations are added.
constexpr int PAWN_CP   = 100;
constexpr int KNIGHT_CP = 320;
constexpr int BISHOP_CP = 330;
constexpr int ROOK_CP   = 500;
constexpr int QUEEN_CP  = 900;

}  // namespace

// Five popcounts per side off the piece bitboards, rather than a walk over the
// 64 squares. The king is not scored: both sides always have exactly one, so
// any value it carried would cancel out.
int MaterialEvaluator::evaluate(const Position& pos) const {
    const auto material = [&pos](Color c) {
        return PAWN_CP   * pos.count(PieceType::PAWN,   c)
             + KNIGHT_CP * pos.count(PieceType::KNIGHT, c)
             + BISHOP_CP * pos.count(PieceType::BISHOP, c)
             + ROOK_CP   * pos.count(PieceType::ROOK,   c)
             + QUEEN_CP  * pos.count(PieceType::QUEEN,  c);
    };

    const int whiteRelative = material(Color::WHITE) - material(Color::BLACK);
    return pos.whiteToMove() ? whiteRelative : -whiteRelative;
}
BlendEvaluator::BlendEvaluator(std::unique_ptr<Evaluator> first,
                               std::unique_ptr<Evaluator> second, int mix)
    : first_(std::move(first)), second_(std::move(second)), mix_(mix) {
    label_ = std::string("blend(") + first_->name() + " " +
             std::to_string(100 - mix_) + "% / " + second_->name() + " " +
             std::to_string(mix_) + "%)";
}

int BlendEvaluator::evaluate(const Position& pos) const {
    // Integer arithmetic, and the division truncates toward zero — which is
    // symmetric about zero, so the blend carries no bias toward the side to
    // move that neither of its parts has.
    return (first_->evaluate(pos) * (100 - mix_) +
            second_->evaluate(pos) * mix_) / 100;
}



std::unique_ptr<Evaluator> makeEvaluator(std::string_view name,
                                         std::string_view weightsFile) {
    if (name == "material") return std::make_unique<MaterialEvaluator>();
    if (name == "mlp") {
        // Reported here rather than at the call site: only this function knows
        // WHY it failed, and "wrong shape" and "no such file" need different
        // fixes. The caller only needs to know that nothing was swapped in.
        try {
            return std::make_unique<MlpEvaluator>(std::string(weightsFile));
        } catch (const std::exception& error) {
            std::cerr << "mlp evaluator: " << error.what() << "\n";
            return nullptr;
        }
    }
    if (name == "blend") {
        // Both must load. A blend missing half of itself is not a fallback, it
        // is a different evaluator wearing this one's name.
        auto material = makeEvaluator("material");
        auto model = makeEvaluator("mlp", weightsFile);
        if (!material || !model) return nullptr;
        return std::make_unique<BlendEvaluator>(std::move(material),
                                                std::move(model));
    }
    return nullptr;
}