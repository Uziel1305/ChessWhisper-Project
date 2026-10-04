"""The training target: asinh(cp / S), and its exact inverse.

Raw centipawns are a poor regression target and the measured reason is the mate
band. 4.7% of rows carry a target between 10,010 and 10,680 — some 43 times the
median row's 251 — so under mean squared error that 4.7% would carry a large
share of the gradient, and the model would come out accurate on positions whose
verdict is already obvious and loose near equality, which is the only place the
eval bar and move classification are actually read.

asinh compresses the tail without discarding it: it is linear near zero, so an
error of 20 cp in a balanced position costs what it should, and logarithmic far
out, so the difference between +8 and +10 pawns costs almost nothing. It takes
negatives directly, unlike log, and needs no epsilon or sign-and-magnitude
split — asinh(-x) = -asinh(x) exactly.

This is NOT part of the dataset. CLAUDE.md's rule is that any training-time
transformation belongs to the training script so it can change without
regenerating a single row, and that is exactly what this is: target_value stays
in centipawns on disk, and S can be revised here with nothing downstream to
rebuild. canonical.py is the other thing — a frozen scale with files checksummed
against it.

Nothing is clamped here. The clamp belongs at the other end, in the engine
(CW-236), where the model's OUTPUT has to stay clear of the search's proven-mate
band at asinh(29.936) = 4.093. Clamping the input would flatten real distinctions
the labels paid Stockfish time to make.
"""

import math

# The scale factor: centipawns per unit before the squash. 1000 is one pawn, so a
# one-pawn advantage lands at asinh(1) = 0.881 and the whole decided-game range
# compresses above it.
S = 1000


def to_target(cp):
    """Centipawns, side-to-move relative, to the model's target."""
    return math.asinh(cp / S)


def to_cp(target):
    """The exact inverse. A round trip returns the original to within rounding.

    Exact matters: it means any difference between the model's centipawn output
    and the label is prediction error and nothing else — the transform
    contributes none of it, so CW-234's bucketed report measures the model
    rather than the measurement.
    """
    return S * math.sinh(target)


# Where the distribution lands in target units, recorded rather than recomputed
# by every reader — CW-230's last bullet, and what CW-234's bucketed error report
# is interpreted against. Measured over all 600,000 labeled positions.
LANDMARKS = {
    "median |cp|, train": 251,
    "p90": 847,
    "p99": 1325,
    "max |cp| observed": 9165,
    "cp ceiling (MAX_CP)": 10000,
    "mate in 68": 10010,
    "mate in 1": 10680,
    "search's proven-mate band": 29936,
}

# The one thing worth noticing in that table: the entire mate band, 670
# centipawns wide by deliberate design in CW-160, compresses to 0.065 of target
# space — mate in 1 at 3.0637 against mate in 68 at 2.9992. The ordering survives
# and the inverse recovers it exactly, but the model has almost no gradient
# incentive to tell a mate in 1 from a mate in 68. That is the right priority for
# an evaluation function and the wrong one for a mate solver, which the engine's
# search is, and does separately.


def main():
    print(f"asinh(cp / {S:,})\n")
    for label, cp in LANDMARKS.items():
        print(f"  {label:28} {cp:>6,} cp  ->  {to_target(cp):+.4f}")
    print(f"\n  mate band width: {to_target(10680) - to_target(10010):.4f} "
          f"in target units, from {10680 - 10010} cp")


if __name__ == "__main__":
    main()