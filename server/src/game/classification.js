// Turns a move's centipawn loss into a verdict. Pure: no I/O, no state — the
// caller (GameManager) has already got the two evaluations in hand.
//
// The thresholds are the project's documented ones, decided September 2026 (see
// "Move classification thresholds" in CLAUDE.md). They live in one table so a
// change to them is a one-line edit here and in that entry, not a logic change.
const THRESHOLDS = Object.freeze([
    { max: 10, verdict: 'best' },
    { max: 50, verdict: 'good' },
    { max: 100, verdict: 'inaccuracy' },
    { max: 200, verdict: 'mistake' },
]);

// Anything above the last threshold's max.
const WORST_VERDICT = 'blunder';

function classify(loss) {
    for (const { max, verdict } of THRESHOLDS) {
        if (loss <= max) return verdict;
    }
    return WORST_VERDICT;
}

// Both evaluations are white-perspective centipawns (what the eval bar shows and
// what the engine facade returns), so which way is "worse" depends on who moved:
// white loses when the number falls, black when it rises. evalBefore is the
// position the mover was facing, evalAfter the position their move produced.
// Clamped at 0 — a move that improves on the previous evaluation costs nothing,
// and the engine's own noise between two searches must not read as a negative
// loss.
function cpLoss({ evalBefore, evalAfter, mover }) {
    const drop = mover === 'white' ? evalBefore - evalAfter : evalAfter - evalBefore;
    return Math.max(0, drop);
}

module.exports = { classify, cpLoss, THRESHOLDS };
