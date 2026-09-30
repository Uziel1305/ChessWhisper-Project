// The same pool as pool.test.js, at two workers. A separate file because
// ENGINE_WORKER_COUNT is read once, at module load, and node --test runs each
// file in its own process — so this is its own, separate pool instance.
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ENGINE_BINARY_PATH = path.join(__dirname, '..', 'test-support', 'fake-engine.js');
process.env.ENGINE_WORKER_COUNT = '2';

const pool = require('../src/pool');

const FAKE_RESULT = { cp: 77, mateIn: null, bestMove: 'e2e4' };

test.after(() => pool._shutdown());

test('a crash fails only its own request, not the one on the other worker', async () => {
    // Both in flight at once, so each is on its own worker.
    const slow = pool.evaluate('FAKE-slow w - - 0 1', 1000);
    const crash = pool.evaluate('FAKE-crash w - - 0 1', 1000);

    const [slowOutcome, crashOutcome] = await Promise.allSettled([slow, crash]);

    assert.equal(crashOutcome.status, 'rejected');
    assert.equal(slowOutcome.status, 'fulfilled');
    assert.deepEqual(slowOutcome.value, FAKE_RESULT);
});

test('concurrent requests beyond the worker count are all served', async () => {
    const fens = ['FAKE-slow', 'FAKE-fast', 'FAKE-slow', 'FAKE-fast', 'FAKE-slow', 'FAKE-fast'];
    const results = await Promise.all(fens.map((f) => pool.evaluate(`${f} w - - 0 1`, 200)));

    assert.equal(results.length, fens.length);
    for (const result of results) assert.deepEqual(result, FAKE_RESULT);
    assert.equal(pool._workerPids().length, 2, 'still exactly two workers');
});
