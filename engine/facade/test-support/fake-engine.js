#!/usr/bin/env node
// A minimal, scriptable stand-in for a real UCI engine, used only by this
// facade's own tests (never referenced by ENGINE_BINARY_PATH outside test/).
// Speaks just enough UCI to exercise pool.js's worker lifecycle — one
// process, reused across many position/go cycles, exactly like the real
// binary is meant to be used now.
//
// What it does on a given request is read from a token in the `position fen`
// line itself, not an env var: a worker process is spawned once and reused
// for many requests that may each need different simulated behavior, and env
// is fixed at spawn time.
//
// Recognised fen prefixes (before the first '-'; anything else behaves like
// 'fast', so an ordinary test fen needs no token at all):
//   FAKE-fast    respond immediately with a fixed score
//   FAKE-slow    respond after FAKE_DELAY_MS (default 50ms) with a fixed score
//   FAKE-hang    never respond — exercises pool.js's own timeout/respawn path
//   FAKE-crash   exit(1) immediately — exercises the unexpected-exit path

const readline = require('readline');

const FAKE_CP = 77; // arbitrary and fixed, so tests can assert on it exactly

const rl = readline.createInterface({ input: process.stdin });
let pendingFen = null;

function respond(fen) {
    const behavior = (fen || '').split(' ')[0].split('-')[1] || 'fast';
    if (behavior === 'crash') {
        process.exit(1);
    }
    if (behavior === 'hang') {
        return; // deliberately never answers
    }
    const delayMs = behavior === 'slow' ? Number(process.env.FAKE_DELAY_MS || 50) : 0;
    setTimeout(() => {
        console.log(`info depth 1 score cp ${FAKE_CP}`);
        console.log('bestmove e2e4');
    }, delayMs);
}

rl.on('line', (line) => {
    if (line === 'uci') {
        console.log('uciok');
    } else if (line === 'isready') {
        console.log('readyok');
    } else if (line.startsWith('position fen ')) {
        pendingFen = line.slice('position fen '.length);
    } else if (line.startsWith('go ')) {
        respond(pendingFen);
    }
});
