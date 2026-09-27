// The game server's only door to the engine facade. Posts a position and a time
// budget, returns { cp, mateIn }: the evaluation in centipawns and, when the
// engine found a forced mate, its signed distance (null otherwise) — both from
// WHITE's perspective (the facade normalises UCI's side-to-move scores, so
// nothing here or in GameManager needs to know whose turn it was).
//
// This file reports what happened — it resolves with { cp, mateIn } or rejects — and
// protects the rest of the process from a dead engine (the circuit breaker
// below). The policy that a slow or unavailable engine must never delay a move
// lives in GameManager, not here.

// CLAUDE.md's per-evaluation budget.
const DEFAULT_BUDGET_MS = 200;

// The facade cuts a request off at budgetMs + 500 and answers 504. This cap is
// deliberately longer, so a stuck engine normally fails through the facade's
// answer and this only fires when the facade itself has stopped responding.
const TIMEOUT_MARGIN_MS = 1000;

// Circuit breaker. When the engine service is down its hostname stops
// resolving, and every lookup of it holds one of libuv's four getaddrinfo
// threads for ~8s — the abort above frees this code but not the thread. A few of
// those starve every other lookup in the process, including Postgres opening a
// new connection, which delayed game.end by ~6.5s in a real run with the engine
// stopped. So after any failure the client stops touching the network at all
// (no fetch, so no lookup) for COOLDOWN_MS. It is longer than one stuck lookup,
// which keeps a dead engine to about one thread at a time.
//
// After the cool-down exactly one request is let through as a probe: success
// closes the circuit, failure re-opens it for another full cool-down. The cost
// is that the eval bar stays dark for up to COOLDOWN_MS after the engine comes
// back — cheap next to a stalled game.
const COOLDOWN_MS = 10000;

let tripped = false;   // a failure has opened the circuit and no probe has closed it yet
let openUntil = 0;     // while now() is before this, every call is rejected untouched
let probing = false;   // the single post-cool-down trial request is in flight
let now = Date.now;    // swappable clock, so tests can step past the cool-down

// async, so every failure — including a missing ENGINE_URL — is a rejection and
// never a synchronous throw the caller would have to guard separately.
// ENGINE_URL is read at call time rather than at load so tests can point it at
// a stub.
async function evaluate(fen, budgetMs = DEFAULT_BUDGET_MS) {
    const base = process.env.ENGINE_URL;
    // A configuration error, not an engine failure: it says nothing about the
    // engine's health, so it neither consults nor trips the breaker.
    if (!base) throw new Error('ENGINE_URL is not set');

    if (tripped) {
        if (now() < openUntil || probing) throw new Error('engine unavailable (circuit open)');
        probing = true; // this call is the probe
    }

    try {
        const cp = await request(base, fen, budgetMs);
        tripped = false;
        probing = false;
        return cp;
    } catch (err) {
        tripped = true;
        probing = false;
        openUntil = now() + COOLDOWN_MS;
        throw err;
    }
}

async function request(base, fen, budgetMs) {
    const res = await fetch(`${base}/evaluate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fen, budgetMs }),
        signal: AbortSignal.timeout(budgetMs + TIMEOUT_MARGIN_MS),
    });
    if (!res.ok) throw new Error(`engine responded ${res.status}`);

    // The facade adds mateIn only when the engine reported a forced mate
    // (white-perspective, signed: positive = White mates). It's normalized to
    // null here so every caller gets one shape, whether or not the key was sent.
    const { cp, mateIn } = await res.json();
    if (!Number.isInteger(cp)) throw new Error('engine returned no integer cp');
    if (mateIn !== undefined && !Number.isInteger(mateIn)) {
        throw new Error('engine returned a non-integer mateIn');
    }
    return { cp, mateIn: mateIn ?? null };
}

// Test hooks: the breaker is module-level state, and its clock has to be
// steppable. Nothing in the server calls these.
function _resetBreaker() {
    tripped = false;
    openUntil = 0;
    probing = false;
    now = Date.now;
}

function _setClock(fn) {
    now = fn;
}

module.exports = { evaluate, DEFAULT_BUDGET_MS, COOLDOWN_MS, _resetBreaker, _setClock };
