const { classify, cpLoss } = require('../src/game/classification');

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
