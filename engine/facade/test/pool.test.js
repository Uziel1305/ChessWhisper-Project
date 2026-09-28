// pool.js's own state (workers, queue) is module-level, so every test in this
// file shares one pool instance, run in declaration order (node:test's
// default) — deliberately, since it lets later tests observe the earlier
// ones' effects (a respawned worker's new pid, etc.) the way the real,
// long-lived facade process would. node --test isolates each test *file* in
// its own process by default, so this never collides with index.test.js's
// own, separate pool instance running alongside it.
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

// Must be set before pool.js (and its uci.js dependency) is first required —
// ENGINE_BINARY_PATH is read once, at module load. The fixture lives outside
// test/ on purpose: node --test's default discovery treats any .js file
// inside a directory literally named "test" as a candidate test file, and
// this one hangs forever on its own stdin listener if run that way — it
// reliably hung the whole suite until it was moved out here.
process.env.ENGINE_BINARY_PATH = path.join(__dirname, '..', 'test-support', 'fake-engine.js');
process.env.ENGINE_WORKER_COUNT = '1';

const pool = require('../src/pool');

const FAKE_CP = 77; // matches test-support/fake-engine.js's fixed score
// What pool.evaluate resolves for an ordinary (non-mate) answer. At this level
// mateIn is always present, as null — it's the HTTP layer that omits it.
const FAKE_RESULT = { cp: FAKE_CP, mateIn: null };

// A live worker's open stdio keeps node --test from ever exiting on its own —
// nothing tears the process down for us the way a container teardown would
// in production, so the suite has to.
test.after(() => pool._shutdown());

test('reuses the same process across two sequential calls', async () => {
    const first = await pool.evaluate('FAKE-fast w - - 0 1', 200);
    const pidAfterFirst = pool._workerPids()[0];
    const second = await pool.evaluate('FAKE-fast w - - 0 1', 200);
    const pidAfterSecond = pool._workerPids()[0];

    assert.deepEqual(first, FAKE_RESULT);
    assert.deepEqual(second, FAKE_RESULT);
    assert.equal(pidAfterSecond, pidAfterFirst, 'no second process was spawned for the second call');
});

test('two concurrent calls at pool size 1 are queued, not interleaved', async () => {
    const startedAt = Date.now();
    // Not awaited individually — both are in flight before either resolves,
    // which is the scenario that would corrupt test-support/fake-engine.js's
    // single-`pendingFen` state if pool.js ever dispatched a second request
    // to a worker still busy with the first.
    const slow = pool.evaluate('FAKE-slow w - - 0 1', 200); // fixture delay: 50ms
    const fast = pool.evaluate('FAKE-fast w - - 0 1', 200);

    const [slowResult, fastResult] = await Promise.all([slow, fast]);
    const elapsed = Date.now() - startedAt;

    assert.deepEqual(slowResult, FAKE_RESULT);
    assert.deepEqual(fastResult, FAKE_RESULT);
    // The fast call can only have been *dispatched* after the slow one's
    // bestmove freed the (single) worker — so the total wall-clock time for
    // both to resolve is at least the slow one's own delay, not ~0.
    assert.ok(elapsed >= 45, `expected serialized dispatch to take >=~50ms, took ${elapsed}ms`);
    assert.equal(pool._workerPids().length, 1, 'still exactly one worker — no ad-hoc extra process');
});

test('a hung call times out, and the pool recovers with a fresh worker', async () => {
    const pidBefore = pool._workerPids()[0];

    await assert.rejects(
        pool.evaluate('FAKE-hang w - - 0 1', 30), // facade deadline: 30 + 500ms margin
        (err) => {
            assert.equal(err.timedOut, true);
            return true;
        }
    );

    const pidAfter = pool._workerPids()[0];
    assert.notEqual(pidAfter, pidBefore, 'the timed-out worker was killed and replaced');

    // The replacement is fully usable — proves this is a real recovery, not
    // just an empty slot.
    const result = await pool.evaluate('FAKE-fast w - - 0 1', 200);
    assert.deepEqual(result, FAKE_RESULT);
}, { timeout: 5000 });

test('an unexpected exit is handled the same way as a timeout', async () => {
    const pidBefore = pool._workerPids()[0];

    await assert.rejects(
        pool.evaluate('FAKE-crash w - - 0 1', 1000), // large budget: rules out a coincidental timeout
        (err) => {
            assert.notEqual(err.timedOut, true, 'a crash is not a timeout');
            return true;
        }
    );

    const pidAfter = pool._workerPids()[0];
    assert.notEqual(pidAfter, pidBefore, 'the crashed worker was killed and replaced');

    const result = await pool.evaluate('FAKE-fast w - - 0 1', 200);
    assert.deepEqual(result, FAKE_RESULT);
});

// The fixture reports `mate 3` from the side to move, like a real engine. The
// same UCI line must come out as White mating when White is to move and as
// Black mating when Black is — through the persistent worker, not just in
// uci.test.js's isolated parser.
test('a mate answer carries its distance, signed from White\'s perspective', async () => {
    assert.deepEqual(await pool.evaluate('FAKE-mate3 w - - 0 1', 200), { cp: 10000, mateIn: 3 });
    assert.deepEqual(await pool.evaluate('FAKE-mate3 b - - 0 1', 200), { cp: -10000, mateIn: -3 });
});
