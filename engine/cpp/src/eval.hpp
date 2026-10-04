#pragma once
#include <memory>
#include <string_view>
#include "board.hpp"
#include <string>
// Static evaluation in centipawns from the SIDE TO MOVE's perspective —
// positive means the side to move stands better. That is what negamax needs
// and what UCI's "score cp" reports, so nothing downstream flips it.
//
// Search holds a const Evaluator& and never learns which implementation it
// has. Adding one later — an ML model reading trained weights — is a new
// subclass plus a line in makeEvaluator, with no change to search.

class Evaluator{
    public:
        //need to define as virtual because when deleteing the real objects, it will cal their destructors first
        virtual ~Evaluator() = default;
        virtual int evaluate(const Position& pos) const = 0;
        // Reported in the engine's search output, so a UCI option that never
        // applied is visible rather than silently leaving the default in place.
        virtual const char* name() const = 0;
};

class MaterialEvaluator : public Evaluator {
public:
    int evaluate(const Position& pos) const override;
    const char* name() const override { return "material"; }
};
// Declared but not implemented — CW-116 deferred. Instantiating this will
// fail at link time until eval.cpp defines it.
class PstEvaluator : public Evaluator {
public:
    int evaluate(const Position& pos) const override;
    const char* name() const override { return "pst"; }
};

// nullptr for an unknown name, so the caller rejects the setoption rather
// than quietly keeping the previous evaluator. Also nullptr when an evaluator
// needs a weights file and that file is missing or malformed — a model that
// cannot be loaded must not be replaced by one that silently isn't there.
std::unique_ptr<Evaluator> makeEvaluator(std::string_view name,
                                         std::string_view weightsFile = {});




// The average of two evaluators, in the centipawns they both already return —
// an ensemble, not a hierarchy. Both score from the side to move, so the mean
// is a meaningful number rather than a mixture of two scales.
//
// Worth trying because the two are wrong in different ways: material is crude
// but never wrong about material, while the model carries positional judgement
// with a median error of 164 cp. Averaging two noisy estimates of one quantity
// reduces the error wherever those errors are not perfectly correlated — which
// is why this is an experiment and not a compromise.
//
// It costs what its parts cost: material is five popcounts a side, the model is
// the folded accumulation, so a blend runs at essentially the model's speed.
class BlendEvaluator : public Evaluator {
public:
    // mix is the SECOND evaluator's share as a percentage; 50 is the mean.
    BlendEvaluator(std::unique_ptr<Evaluator> first,
                   std::unique_ptr<Evaluator> second, int mix = 50);

    int evaluate(const Position& pos) const override;
    const char* name() const override { return label_.c_str(); }

private:
    std::unique_ptr<Evaluator> first_;
    std::unique_ptr<Evaluator> second_;
    int mix_;
    // Built once and held: name() returns a pointer that must outlive the call,
    // and a blend reporting only "blend" would leave the search log unable to
    // say what was actually mixed.
    std::string label_;
};

