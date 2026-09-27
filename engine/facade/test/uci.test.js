// parseScoreLine is pure, so it's tested with plain strings — no process, no
// fixture. The sign derivation is the part most likely to be wrong, so every
// combination of (who UCI says mates) x (who is to move) is pinned here: a
// flip applied to the wrong branch cannot pass all four by coincidence.
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseScoreLine } = require('../src/uci');

const WHITE_TO_MOVE = true;
const BLACK_TO_MOVE = false;

test('a cp score is flipped to white\'s perspective and carries no mateIn', () => {
    assert.deepEqual(parseScoreLine('info depth 12 score cp 35 nodes 1000', WHITE_TO_MOVE), { cp: 35, mateIn: null });
    assert.deepEqual(parseScoreLine('info depth 12 score cp 35 nodes 1000', BLACK_TO_MOVE), { cp: -35, mateIn: null });
});

test('a cp score is still clamped to +-10000', () => {
    assert.deepEqual(parseScoreLine('info depth 1 score cp 25000', WHITE_TO_MOVE), { cp: 10000, mateIn: null });
    assert.deepEqual(parseScoreLine('info depth 1 score cp -25000', WHITE_TO_MOVE), { cp: -10000, mateIn: null });
});

// UCI's `mate N` is from the side to move: positive means the side to move
// delivers mate in N, negative means it gets mated in |N|. mateIn is
// white-perspective: positive = White mates, negative = Black mates.
test('mate 3 with white to move: White mates in 3', () => {
    assert.deepEqual(parseScoreLine('info depth 20 score mate 3', WHITE_TO_MOVE), { cp: 10000, mateIn: 3 });
});

test('mate 3 with black to move: Black mates in 3', () => {
    assert.deepEqual(parseScoreLine('info depth 20 score mate 3', BLACK_TO_MOVE), { cp: -10000, mateIn: -3 });
});

test('mate -2 with white to move: White is mated in 2, i.e. Black mates', () => {
    assert.deepEqual(parseScoreLine('info depth 20 score mate -2', WHITE_TO_MOVE), { cp: -10000, mateIn: -2 });
});

test('mate -2 with black to move: Black is mated in 2, i.e. White mates', () => {
    assert.deepEqual(parseScoreLine('info depth 20 score mate -2', BLACK_TO_MOVE), { cp: 10000, mateIn: 2 });
});

// `mate 0` means the position is already checkmate — the side to move has been
// mated. There is no forced mate *ahead*, and a zero distance can't carry who
// mated (JSON has no -0), so mateIn is null. evalCp still pins to the winner's
// end, and game.end is what announces the checkmate itself.
test('mate 0 (already checkmate) keeps the pinned cp but carries no mateIn', () => {
    assert.deepEqual(parseScoreLine('info depth 0 score mate 0', WHITE_TO_MOVE), { cp: -10000, mateIn: null });
    assert.deepEqual(parseScoreLine('info depth 0 score mate 0', BLACK_TO_MOVE), { cp: 10000, mateIn: null });
});

test('an info line with no score returns null', () => {
    assert.equal(parseScoreLine('info depth 5 nodes 1234 nps 50000', WHITE_TO_MOVE), null);
});
