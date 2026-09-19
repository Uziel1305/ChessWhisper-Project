// The game server's only door to the engine facade. Posts a position and a time
// budget, returns the evaluation in centipawns from WHITE's perspective (the
// facade normalises UCI's side-to-move scores, so nothing here or in
// GameManager needs to know whose turn it was).
//
// This file only reports what happened: it resolves with a number or rejects.
// The policy that a slow or dead engine must never delay a move lives in
// GameManager, not here.

// CLAUDE.md's per-evaluation budget.
const DEFAULT_BUDGET_MS = 200;

// The facade cuts a request off at budgetMs + 500 and answers 504. This cap is
// deliberately longer, so a stuck engine normally fails through the facade's
// answer and this only fires when the facade itself has stopped responding.
const TIMEOUT_MARGIN_MS = 1000;

// async, so every failure — including a missing ENGINE_URL — is a rejection and
// never a synchronous throw the caller would have to guard separately.
// ENGINE_URL is read at call time rather than at load so tests can point it at
// a stub.
async function evaluate(fen, budgetMs = DEFAULT_BUDGET_MS) {
    const base = process.env.ENGINE_URL;
    if (!base) throw new Error('ENGINE_URL is not set');

    const res = await fetch(`${base}/evaluate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fen, budgetMs }),
        signal: AbortSignal.timeout(budgetMs + TIMEOUT_MARGIN_MS),
    });
    if (!res.ok) throw new Error(`engine responded ${res.status}`);

    const { cp } = await res.json();
    if (!Number.isInteger(cp)) throw new Error('engine returned no integer cp');
    return cp;
}

module.exports = { evaluate, DEFAULT_BUDGET_MS };
