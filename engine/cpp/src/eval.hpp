#pragma once
#include <memory>
#include <string_view>
#include "board.hpp"

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
// than quietly keeping the previous evaluator.
std::unique_ptr<Evaluator> makeEvaluator(std::string_view name);

