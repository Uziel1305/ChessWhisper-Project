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
//   FAKE-mate3   respond immediately with `score mate 3` (side to move mates
//                in 3) — exercises mate-distance propagation
//   FAKE-nomove  respond with `bestmove 0000`, as our engine does when the
//                position has no legal move
//   FAKE-nodrain respond normally, then ignore the next `isready` — exercises
//                the post-search drain's own timeout/respawn path
//   FAKE-trailing respond normally, then ~TRAIL_MS later print a stray scored
//                `info` line and a stray `bestmove` — output a search left
//                behind, which the drain must keep off the next request

const readline = require('readline');

const FAKE_CP = 77; // arbitrary and fixed, so tests can assert on it exactly
const TRAIL_CP = 999; // the stray score; a test seeing it means no drain
const TRAIL_MS = 50;

const rl = readline.createInterface({ input: process.stdin });
let pendingFen = null;
let ignoreNextIsready = false;
// Non-null while trailing output is still to come: stdin lines wait here and
// are handled only after it is printed. A real engine reads its stdin in
// order, so `readyok` can never overtake output it already owed — without
// this the fake would answer `isready` early and no drain could be tested.
let held = null;

function respond(fen) {
    const behavior = (fen || '').split(' ')[0].split('-')[1] || 'fast';
    if (behavior === 'crash') {
        process.exit(1);
    }
    if (behavior === 'hang') {
        return; // deliberately never answers
    }
    if (behavior === 'nodrain') {
        ignoreNextIsready = true;
    }
    const delayMs = behavior === 'slow' ? Number(process.env.FAKE_DELAY_MS || 50) : 0;
    // Reported from the side to move, exactly as a real UCI engine does — the
    // facade, not this fixture, is what turns it into White's perspective.
    const score = behavior === 'mate3' ? 'mate 3' : `cp ${FAKE_CP}`;
    const move = behavior === 'nomove' ? '0000' : 'e2e4';
    if (behavior === 'trailing') {
        held = [];
    }
    setTimeout(() => {
        console.log(`info depth 1 score ${score}`);
        console.log(`bestmove ${move}`);
        if (behavior === 'trailing') {
            setTimeout(() => {
                console.log(`info depth 1 score cp ${TRAIL_CP}`);
                console.log('bestmove a2a3');
                const waiting = held;
                held = null;
                for (const line of waiting) onLine(line);
            }, TRAIL_MS);
        }
    }, delayMs);
}

function handle(line) {
    if (line === 'uci') {
        console.log('uciok');
    } else if (line === 'isready') {
        if (ignoreNextIsready) {
            ignoreNextIsready = false;
            return;
        }
        console.log('readyok');
    } else if (line.startsWith('position fen ')) {
        pendingFen = line.slice('position fen '.length);
    } else if (line.startsWith('go ')) {
        respond(pendingFen);
    }
}

function onLine(line) {
    if (held) held.push(line);
    else handle(line);
}

rl.on('line', onLine);
