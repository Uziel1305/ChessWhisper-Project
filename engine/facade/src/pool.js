const readline = require('readline');
const { spawnEngine, whiteToMoveFrom, parseScoreLine } = require('./uci');

// Replaces uci.js's old per-call evaluate(): that spawned a brand-new
// Stockfish process (full uci/uciok/isready/readyok handshake included) for
// every single request, all inside a ~700ms deadline — which is what made
// the first several evaluations of any session reliably fail (see the
// investigation this file's rewrite came out of). This file keeps a small
// number of engine processes alive across many requests instead.
//
//   evaluate(fen, budgetMs)  ->  Promise<{ cp, mateIn }>
//
// mateIn is null unless the engine reported a mate (see uci.js).
//
// Same signature and same error shape (a plain Error, or one with
// `.timedOut = true`) as uci.js's old evaluate() — index.js's status-code
// mapping (504 vs 500) depends on that property and needs no other change.

// How many engine processes to keep warm. One is enough to remove the cost
// this file replaces (spawn-per-request); CLAUDE.md's "one worker per core"
// figure is the eventual target for the real custom engine at production
// scale, not this Stockfish stand-in — scaling up is a later, separate,
// evidence-driven step, not a rewrite (this pool is already written for any
// N). Never a literal: reads from the same kind of compose `environment:`
// entry ENGINE_BINARY_PATH/ENGINE_PORT already use.
const WORKER_COUNT = Number(process.env.ENGINE_WORKER_COUNT) || 1;

// The facade's own hard deadline for one evaluation. Unchanged from uci.js's
// old per-call timeout margin, deliberately: this rewrite is judged on
// architecture alone, not on retuned values.
const TIMEOUT_MARGIN_MS = 500;

// One entry per worker slot, 0..WORKER_COUNT-1, filled at module load and
// replaced in place (same index) whenever a worker times out or crashes —
// callers never see a slot disappear, only its identity change underneath it.
const workers = [];

// FIFO — oldest request first, same convention matchmaking/queue.js already
// uses for its own waiting list.
const queue = [];

// The single place a worker's death is handled, whichever of three signals
// caused it (request timeout, unexpected exit, stdin error). Idempotent via
// `dying`: killing the child ourselves below fires its own 'exit' event
// later, and this must not double-handle that as a second, unrelated death.
function handleWorkerDeath(worker, err) {
    if (worker.dying) return;
    worker.dying = true;

    const req = worker.current;
    worker.current = null;
    if (req) {
        clearTimeout(req.timer);
        req.reject(err);
    }

    console.error(`engine worker ${worker.slot} died (pid ${worker.child.pid}):`, err.message);
    try { worker.rl.close(); } catch (e) { /* already closed */ }
    try { worker.child.kill(); } catch (e) { /* already gone */ }

    const fresh = createWorker(worker.slot);
    workers[worker.slot] = fresh;
    // fresh worker's own handshake calls tryDispatch() once it reaches 'ready'.
}

// The worker's one persistent line listener, covering its whole lifetime —
// not swapped out between handshake and steady state. `phase` and `current`
// are what change; the listener itself never does, which is what keeps a
// worker's per-request state from ever leaking into the wrong request.
function attachLineHandler(worker) {
    worker.rl.on('line', (line) => {
        if (worker.phase === 'handshake') {
            if (line === 'uciok') {
                worker.child.stdin.write('isready\n');
            } else if (line === 'readyok') {
                worker.phase = 'ready';
                console.log(`engine worker ${worker.slot} ready (pid ${worker.child.pid})`);
                tryDispatch();
            }
            return;
        }

        // phase === 'ready'. No current request means this line belongs to
        // nothing (shouldn't happen — 'bestmove' always clears `current` —
        // but a stray line here must never crash the facade).
        if (!worker.current) return;
        if (line.startsWith('info ')) {
            // cp and mateIn come from the same line and are kept together:
            // the latest scored line wins as a pair, never mixing a cp from
            // one line with a mate distance from another.
            const parsed = parseScoreLine(line, worker.current.whiteToMove);
            if (parsed !== null) {
                worker.current.score = parsed.cp;
                worker.current.mateIn = parsed.mateIn;
            }
        } else if (line.startsWith('bestmove')) {
            const { score, mateIn } = worker.current;
            finishCurrent(worker,
                score === null ? new Error('engine reported no score') : null,
                { cp: score, mateIn });
        }
    });
}

// The normal, successful (or cleanly-answered-but-scoreless) completion path
// — as opposed to handleWorkerDeath, this leaves the worker alive and
// immediately reusable, since nothing here means the *process* is broken.
function finishCurrent(worker, err, value) {
    const req = worker.current;
    if (!req) return;
    clearTimeout(req.timer);
    worker.current = null;
    if (err) req.reject(err); else req.resolve(value);
    tryDispatch();
}

// Spawns one worker and begins its handshake. Returns immediately — nothing
// here is awaited; the worker announces itself ready via attachLineHandler
// above, whether this is the pool's initial fill or a post-death respawn.
function createWorker(slot) {
    const child = spawnEngine();
    const worker = {
        slot,
        child,
        rl: readline.createInterface({ input: child.stdout }),
        phase: 'handshake', // 'handshake' | 'ready'
        dying: false,
        current: null,      // { resolve, reject, timer, score, mateIn, whiteToMove }
    };

    attachLineHandler(worker);
    child.on('error', (err) => handleWorkerDeath(worker, err));
    child.stdin.on('error', (err) => handleWorkerDeath(worker, err));
    child.on('exit', () => {
        // Our own kill() in handleWorkerDeath triggers this too; `dying` is
        // already true by then, so this only reacts to a genuine crash.
        if (worker.dying) return;
        handleWorkerDeath(worker, new Error('engine exited unexpectedly'));
    });

    child.stdin.write('uci\n');
    return worker;
}

// Sends one request to a worker already confirmed idle and ready. The timer
// here is what turns a stuck engine into a kill-and-respawn (handleWorkerDeath),
// not just a rejected request — reusing a process that might still be
// "thinking" risks a stray bestmove landing on whatever the *next* request is.
function dispatchToWorker(worker, request) {
    worker.current = {
        resolve: request.resolve,
        reject: request.reject,
        whiteToMove: whiteToMoveFrom(request.fen),
        score: null,
        mateIn: null,
        timer: setTimeout(() => {
            const err = new Error('engine timed out');
            err.timedOut = true;
            handleWorkerDeath(worker, err);
        }, request.budgetMs + TIMEOUT_MARGIN_MS),
    };
    worker.child.stdin.write(`position fen ${request.fen}\ngo movetime ${request.budgetMs}\n`);
}

// Assigns as much of the queue as there are idle, ready workers for. Called
// from every place a worker could newly become available (a request arrives,
// a worker finishes one, a fresh replacement's handshake completes) — there
// is deliberately only this one dispatch path, not one per call site.
function tryDispatch() {
    while (queue.length > 0) {
        const worker = workers.find((w) => w.phase === 'ready' && !w.dying && !w.current);
        if (!worker) return;
        dispatchToWorker(worker, queue.shift());
    }
}

for (let i = 0; i < WORKER_COUNT; i++) {
    workers.push(createWorker(i));
}

function evaluate(fen, budgetMs) {
    return new Promise((resolve, reject) => {
        queue.push({ fen, budgetMs, resolve, reject });
        tryDispatch();
    });
}

// Test hook: lets a test see that a worker's process identity did or didn't
// change (reused across calls vs. killed-and-respawned), without exposing
// worker internals as part of the real API. Same underscore convention
// engineClient.js already uses for its own test-only exports.
function _workerPids() {
    return workers.map((w) => w.child.pid);
}

// Test hook: kills every live worker without respawning. A spawned child's
// open stdio keeps Node's event loop alive, so nothing using this module can
// exit on its own (in the real facade that's fine — the container's own
// teardown kills every process in it — but a test process has no such thing
// tearing it down, so it must do this itself once done).
function _shutdown() {
    for (const worker of workers) {
        worker.dying = true; // skip the 'exit' handler's respawn
        try { worker.rl.close(); } catch (e) { /* already closed */ }
        try { worker.child.kill(); } catch (e) { /* already gone */ }
    }
}

module.exports = { evaluate, _workerPids, _shutdown };
