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

// Used instead of THRESHOLDS when both positions are a forced mate for the same
// side, where every evaluation sits on the same clamped +-10000 and cp loss is
// always 0. Measured in full moves conceded (see mateMovesConceded), not
// centipawns. Never worse than inaccuracy: a move that keeps a forced mate has
// not given the win away, it has only made it slower.
const MATE_THRESHOLDS = Object.freeze([
    { max: 0, verdict: 'best' },
    { max: 2, verdict: 'good' },
]);

const MATE_WORST_VERDICT = 'inaccuracy';

// "Lead slipped away": the mover was at least this far ahead before the move and
// at least this far behind after it, both from their own side. The dead zone
// either side of 0 keeps engine noise around an equal position from firing it,
// and the swing it implies (>= 200 cp) means it only ever accompanies a mistake
// or a blunder.
const LOST_ADVANTAGE_CP = 100;

function lookup(table, worst, value) {
    for (const { max, verdict } of table) {
        if (value <= max) return verdict;
    }
    return worst;
}

function classify(loss) {
    return lookup(THRESHOLDS, WORST_VERDICT, loss);
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

// How many full moves a move gave away against a forced mate, or null when the
// question doesn't apply — either position has no mate, or the mate changed
// hands (that is a blunder, and cp loss already says so).
//
// mateIn is white-perspective full moves, counted from the side to move. Under
// best play the attacker's move takes the distance down by exactly one, and the
// defender's reply leaves it where it was. So the mover concedes whatever the
// distance falls short of that — an attacker who lets it grow, or a defender who
// lets it shrink. Clamped at 0, like cpLoss: an engine that finds a shorter mate
// on the second search than on the first is not the mover's doing.
function mateMovesConceded({ mateBefore, mateAfter, mover }) {
    if (mateBefore == null || mateAfter == null) return null;
    if (Math.sign(mateBefore) !== Math.sign(mateAfter)) return null;
    const before = Math.abs(mateBefore);
    const after = Math.abs(mateAfter);
    const moverIsMating = (mateBefore > 0) === (mover === 'white');
    return moverIsMating
        ? Math.max(0, after - (before - 1))
        : Math.max(0, before - after);
}

function lostAdvantage({ evalBefore, evalAfter, mover }) {
    const sign = mover === 'white' ? 1 : -1;
    return sign * evalBefore >= LOST_ADVANTAGE_CP && sign * evalAfter <= -LOST_ADVANTAGE_CP;
}

// Everything a move.feedback needs, from the two evaluations around the move.
// Without a forced mate on both sides this is exactly classify(cpLoss(...)) —
// cpLoss is returned either way, because it is what feedback.cp_loss records.
function classifyMove({ evalBefore, evalAfter, mateBefore, mateAfter, mover }) {
    const loss = cpLoss({ evalBefore, evalAfter, mover });
    const conceded = mateMovesConceded({ mateBefore, mateAfter, mover });
    return {
        classification: conceded === null
            ? classify(loss)
            : lookup(MATE_THRESHOLDS, MATE_WORST_VERDICT, conceded),
        cpLoss: loss,
        lostAdvantage: lostAdvantage({ evalBefore, evalAfter, mover }),
    };
}

module.exports = {
    classify,
    cpLoss,
    classifyMove,
    mateMovesConceded,
    lostAdvantage,
    THRESHOLDS,
    MATE_THRESHOLDS,
    LOST_ADVANTAGE_CP,
};
