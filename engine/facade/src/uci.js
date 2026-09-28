const { spawn } = require('child_process');
const ENGINE_PATH = process.env.ENGINE_BINARY_PATH || '/app/engine/chesswhisper_engine';

// Pure/stateless UCI helpers. This file owns no process, no listener and no
// lifecycle — pool.js does, since a worker's process, readline interface and
// in-flight request all have to live longer than any single function call
// here. Splitting it this way is also what makes these two pieces trivially
// unit-testable on their own: this file with plain strings, pool.js against a
// scriptable fake engine (see test/fixtures/fake-engine.js).

// Mate scores have no centipawn value; they are clamped to this so the game
// server only ever sees a plain number (and cp loss stays well-defined).
const MATE_CP = 10000;

// Spawns the engine binary. Nothing else — no handshake, no stdin writes.
// Exists so pool.js (and tests) never call child_process directly.
function spawnEngine() {
    return spawn(ENGINE_PATH);
}

// True if white is to move in this FEN. Only the second space-separated
// field says whose move it is; the rest is piece placement, castling, etc.
function whiteToMoveFrom(fen) {
    return fen.split(' ')[1] !== 'b';
}

// Parses one UCI 'info ...' line for a score, from WHITE's perspective. UCI
// reports from the side to move, so the sign is flipped when black is on
// move. Returns null for an info line that carries no score (most don't).
//
// Returns { cp, mateIn }. cp is the clamped centipawn value everything
// downstream already relies on (classification included), mate or not.
// mateIn is the true mate distance, which the clamp above throws away:
// positive when White mates, negative when Black does, null when the score
// is not a mate. `mate 0` — the position is already checkmate — is null too:
// there is no mate ahead, and a zero can't say who delivered it.
function parseScoreLine(line, whiteToMove) {
    const m = line.match(/score (cp|mate) (-?\d+)/);
    if (!m) return null;
    const n = Number(m[2]);
    const isMate = m[1] === 'mate';
    const side = isMate
        ? (n > 0 ? MATE_CP : -MATE_CP)
        : Math.max(-MATE_CP, Math.min(MATE_CP, n));
    const mateSide = isMate && n !== 0 ? n : null;
    return {
        cp: whiteToMove ? side : -side,
        mateIn: mateSide === null ? null : (whiteToMove ? mateSide : -mateSide),
    };
}

module.exports = { spawnEngine, whiteToMoveFrom, parseScoreLine, ENGINE_PATH, MATE_CP };
