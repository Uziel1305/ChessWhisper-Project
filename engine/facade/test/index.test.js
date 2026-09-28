// Thin HTTP-level regression test: pins /evaluate's existing contract
// (200/504/400) unchanged now that it's backed by pool.js instead of a
// per-request spawn. This is the contract server/test/engineClient.test.js
// relies on from the other side — nothing here should ever need to change in
// step with anything there.
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

// Must be set before ../src/index (and its pool.js/uci.js dependencies) is
// first required — ENGINE_BINARY_PATH is read once, at module load. See
// pool.test.js's own note on why this fixture lives outside test/.
process.env.ENGINE_BINARY_PATH = path.join(__dirname, '..', 'test-support', 'fake-engine.js');
process.env.ENGINE_WORKER_COUNT = '1';

const { server } = require('../src/index');
// Same resolved module index.js's own internal require('./pool') already
// loaded and cached — this is the one live pool instance, not a second one.
const pool = require('../src/pool');

let baseUrl;

test.before(async () => {
    // Port 0 lets the OS pick a free one, matching server/test/ws.test.js's
    // own reasoning for the same choice.
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    // A live pool worker's open stdio would otherwise keep node --test from
    // ever exiting — see pool.test.js's own note on _shutdown().
    pool._shutdown();
});

test('POST /evaluate returns 200 {cp} on success', async () => {
    const res = await fetch(`${baseUrl}/evaluate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fen: 'FAKE-fast w - - 0 1', budgetMs: 200 }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { cp: 77 });
});

// The test above's exact {cp: 77} is what proves a non-mate answer carries no
// mateIn key at all. This is the other half: a mate answer adds it, signed
// from White's perspective.
test('POST /evaluate adds mateIn when the engine reports a mate', async () => {
    const res = await fetch(`${baseUrl}/evaluate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fen: 'FAKE-mate3 w - - 0 1', budgetMs: 200 }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { cp: 10000, mateIn: 3 });
});

test('POST /evaluate returns 504 when the engine times out', async () => {
    const res = await fetch(`${baseUrl}/evaluate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fen: 'FAKE-hang w - - 0 1', budgetMs: 30 }),
    });
    assert.equal(res.status, 504);
}, { timeout: 5000 });

test('POST /evaluate returns 400 for a malformed body', async () => {
    const res = await fetch(`${baseUrl}/evaluate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
    });
    assert.equal(res.status, 400);
});

test('POST /evaluate returns 400 for an out-of-range budgetMs', async () => {
    const res = await fetch(`${baseUrl}/evaluate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fen: 'FAKE-fast w - - 0 1', budgetMs: 999999 }),
    });
    assert.equal(res.status, 400);
});
