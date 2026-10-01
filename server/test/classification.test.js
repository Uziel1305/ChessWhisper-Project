const {
    classify,
    cpLoss,
    classifyMove,
    mateMovesConceded,
    lostAdvantage,
} = require('../src/game/classification');

// classification.js is still empty (CW-141's job) — every test here fails right
// now because classify and cpLoss are undefined. The boundaries are the
// project's cp-loss thresholds (decided September 2026):
//
//   best        0 - 10
//   good       11 - 50
//   inaccuracy 51 - 100
//   mistake   101 - 200
//   blunder   201+
//
// Each boundary is tested on both sides, because an off-by-one there (< vs <=)
// is the one bug this table can actually have.
describe('classify', () => {
    it.each([
        [0, 'best'],
        [10, 'best'],
        [11, 'good'],
        [50, 'good'],
        [51, 'inaccuracy'],
        [100, 'inaccuracy'],
        [101, 'mistake'],
        [200, 'mistake'],
        [201, 'blunder'],
        // A mate score clamps to +-10000 (see engine/facade/src/uci.js), so a
        // move that walks into mate from an even position loses about that much.
        [10000, 'blunder'],
        [20000, 'blunder'],
    ])('a loss of %i cp is %s', (loss, verdict) => {
        expect(classify(loss)).toBe(verdict);
    });
});

// Evals are white-perspective centipawns — what the eval bar shows and what the
// engine facade returns — so the mover's colour decides which way is "worse".
describe('cpLoss', () => {
    it("is before minus after when white moves (the eval fell from white's side)", () => {
        // White was +50, moved, and is now -30: an 80 cp drop for white.
        expect(cpLoss({ evalBefore: 50, evalAfter: -30, mover: 'white' })).toBe(80);
    });

    it("is after minus before when black moves (the eval rose towards white)", () => {
        // Black was -50 (good for black), moved, and it is now +30: an 80 cp
        // drop for black. Same numbers as above, opposite sign.
        expect(cpLoss({ evalBefore: -50, evalAfter: 30, mover: 'black' })).toBe(80);
    });

    it('is 0 when the move improves on the previous evaluation', () => {
        expect(cpLoss({ evalBefore: 20, evalAfter: 90, mover: 'white' })).toBe(0);
        expect(cpLoss({ evalBefore: -20, evalAfter: -90, mover: 'black' })).toBe(0);
    });

    it('is 0 when nothing changed', () => {
        expect(cpLoss({ evalBefore: 35, evalAfter: 35, mover: 'white' })).toBe(0);
    });

    it('sees walking into mate as a huge loss', () => {
        expect(cpLoss({ evalBefore: 0, evalAfter: -10000, mover: 'white' })).toBe(10000);
        expect(cpLoss({ evalBefore: 0, evalAfter: 10000, mover: 'black' })).toBe(10000);
    });

    it('feeds classify: a 150 cp drop by black is a mistake', () => {
        const loss = cpLoss({ evalBefore: -40, evalAfter: 110, mover: 'black' });
        expect(loss).toBe(150);
        expect(classify(loss)).toBe('mistake');
    });
});

// Both positions are a forced mate for the same side, so both evals are the same
// clamped +-10000 and cp loss is 0 — the verdict comes from the mate distance.
// mateIn is white-perspective full moves from the side to move: best play by the
// attacker takes it down by one, best defence leaves it unchanged. Verdicts:
// 0 moves conceded best, 1-2 good, 3+ inaccuracy.
function mateMove(mover, mateBefore, mateAfter) {
    const cp = Math.sign(mateBefore) * 10000;
    return classifyMove({ evalBefore: cp, evalAfter: cp, mateBefore, mateAfter, mover });
}

describe('classifyMove with a forced mate on both sides', () => {
    describe('the mover is the one mating', () => {
        it.each([
            // White mates (positive mateIn).
            ['white', 5, 4, 'best'],        // the shortest continuation
            ['white', 5, 3, 'best'],        // engine found a shorter mate: clamped at 0
            ['white', 5, 5, 'good'],        // 1 move conceded
            ['white', 5, 6, 'good'],        // 2
            ['white', 5, 7, 'inaccuracy'],  // 3
            ['white', 5, 8, 'inaccuracy'],  // 4: mate-in-5 played into mate-in-8
            ['white', 1, 1, 'good'],        // skipped mate-in-1 for another mate-in-1
            // Black mates (negative mateIn), same numbers.
            ['black', -5, -4, 'best'],
            ['black', -5, -3, 'best'],
            ['black', -5, -5, 'good'],
            ['black', -5, -6, 'good'],
            ['black', -5, -7, 'inaccuracy'],
            ['black', -5, -8, 'inaccuracy'],
            ['black', -1, -1, 'good'],
        ])('%s, mateIn %i -> %i, is %s', (mover, mateBefore, mateAfter, verdict) => {
            expect(mateMove(mover, mateBefore, mateAfter).classification).toBe(verdict);
        });
    });

    describe('the mover is the one being mated', () => {
        it.each([
            // White is being mated (negative mateIn).
            ['white', -4, -4, 'best'],        // best defence: distance unchanged
            ['white', -4, -6, 'best'],        // prolonged: clamped at 0
            ['white', -4, -3, 'good'],        // 1 move conceded
            ['white', -4, -2, 'good'],        // 2
            ['white', -4, -1, 'inaccuracy'],  // 3
            // Black is being mated (positive mateIn).
            ['black', 4, 4, 'best'],
            ['black', 4, 6, 'best'],
            ['black', 4, 3, 'good'],
            ['black', 4, 2, 'good'],
            ['black', 4, 1, 'inaccuracy'],
        ])('%s, mateIn %i -> %i, is %s', (mover, mateBefore, mateAfter, verdict) => {
            expect(mateMove(mover, mateBefore, mateAfter).classification).toBe(verdict);
        });
    });

    it('still reports the clamped cp loss, which is 0 even when the verdict is worse than best', () => {
        expect(mateMove('white', 5, 8)).toEqual({
            classification: 'inaccuracy',
            cpLoss: 0,
            lostAdvantage: false,
        });
    });
});

// Anything other than a same-side mate on both sides is cp loss's job, exactly
// as before mate distance existed.
describe('classifyMove falls back to cp loss', () => {
    it('when the mate changes hands', () => {
        expect(mateMovesConceded({ mateBefore: 3, mateAfter: -2, mover: 'white' })).toBeNull();
        expect(classifyMove({
            evalBefore: 10000, evalAfter: -10000, mateBefore: 3, mateAfter: -2, mover: 'white',
        })).toMatchObject({ classification: 'blunder', cpLoss: 20000 });
    });

    it('when the mating move is played (mate 0 reaches the server as no mateIn)', () => {
        expect(classifyMove({
            evalBefore: 10000, evalAfter: 10000, mateBefore: 1, mateAfter: null, mover: 'white',
        })).toMatchObject({ classification: 'best', cpLoss: 0 });
    });

    it('when a forced mate is let go', () => {
        expect(classifyMove({
            evalBefore: -10000, evalAfter: -500, mateBefore: -3, mateAfter: null, mover: 'black',
        })).toMatchObject({ classification: 'blunder', cpLoss: 9500 });
    });

    it.each([
        ['white', 30, -10000, -3],
        ['black', -30, 10000, 3],
    ])('when %s walks into a mate from no mate', (mover, evalBefore, evalAfter, mateAfter) => {
        expect(classifyMove({
            evalBefore, evalAfter, mateBefore: null, mateAfter, mover,
        })).toMatchObject({ classification: 'blunder', cpLoss: 10030 });
    });

    it.each([
        [50, -30, 'white'],
        [-50, 30, 'black'],
        [20, 90, 'white'],
        [-40, 110, 'black'],
        [0, -10000, 'white'],
    ])('with no mate on either side: %i -> %i by %s is classify(cpLoss(...))', (evalBefore, evalAfter, mover) => {
        const loss = cpLoss({ evalBefore, evalAfter, mover });
        expect(classifyMove({ evalBefore, evalAfter, mateBefore: null, mateAfter: null, mover }))
            .toMatchObject({ classification: classify(loss), cpLoss: loss });
    });
});

// From the mover's side: at least +100 before and at most -100 after. Evals are
// white-perspective, so black's numbers are the mirror of white's.
describe('lostAdvantage', () => {
    it.each([
        ['white', 100, -100, true],
        ['white', 99, -100, false],     // wasn't clearly ahead
        ['white', 100, -99, false],     // isn't clearly behind
        ['white', 10000, -10000, true], // own mate turned into the opponent's
        ['white', 100, 300, false],     // improved
        ['black', -100, 100, true],
        ['black', -99, 100, false],
        ['black', -100, 99, false],
        ['black', -10000, 10000, true],
        ['black', -100, -300, false],
    ])('%s, %i -> %i, is %s', (mover, evalBefore, evalAfter, expected) => {
        expect(lostAdvantage({ evalBefore, evalAfter, mover })).toBe(expected);
    });

    it('rides alongside the normal verdict', () => {
        expect(classifyMove({
            evalBefore: 150, evalAfter: -150, mateBefore: null, mateAfter: null, mover: 'white',
        })).toEqual({ classification: 'blunder', cpLoss: 300, lostAdvantage: true });
    });
});
