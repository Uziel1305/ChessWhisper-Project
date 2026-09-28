const http = require('http');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const app = require('../src/app');
const pool = require('../src/db/pool');
const { attachHub, closeHub } = require('../src/ws/hub');
const queue = require('../src/matchmaking/queue');



function accessTokenFor(userId) {
    return jwt.sign({ sub: String(userId) }, process.env.JWT_SECRET, {
        algorithm: 'HS256',
        expiresIn: '15m',
    });
}

let server
let port
const openClients=[];
const GameManager = require('../src/game/GameManager');
let activeGame = null;

function connect(token) {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    openClients.push(client);

    return new Promise((resolve, reject) => {
        client.on('open', () => resolve(client));
        client.on('error', reject);
    });
}


// Resolves with the next event this socket receives, or null if none arrives in
// time. That null is what "a lone player is left waiting" looks like from here.
function nextEvent(client, timeoutMs = 1000) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        client.once('message', (raw) => {
            //stops the timer
            clearTimeout(timer);
            resolve(JSON.parse(raw));
        });
    });
}

async function registerPlayer(username) {
    const res = await request(app)
        .post('/api/auth/register')
        .send({ username, password: 'a-strong-password-123' });
    expect(res.status).toBe(201);
    return res.body.userId;
}


describe('matchmaking queue', () => {
    beforeEach(() => {
        // Module state is a singleton and outlives each test. A player left
        // waiting by one test gets matched by the next one's join — which is
        // how QueueTestuser_solo ended up as the slow player's opponent.
        queue.clear();
    });
    beforeAll(async () => {
        server = http.createServer(app);
        attachHub(server);
        await new Promise((resolve) => server.listen(0, resolve));
        port = server.address().port;
    });
    
    afterAll(async () => {
        // The one real match created below (the test right after this) is left
        // unfinished by design — this file only tests matchmaking, not
        // gameplay. Terminating its sockets below fires hub.js's fire-and-
        // forget gameManager.abandon(), racing the DELETE/pool.end() calls
        // that follow it — same race already fixed in moves.test.js. Ending
        // it here first, through GameManager directly (same idiom as
        // evaluation.test.js/privacy.test.js), and awaiting it, means it's
        // already persisted by the time teardown deletes anything.
        if (activeGame && GameManager.get(activeGame.gameId)) {
            await GameManager.resign({ gameId: activeGame.gameId, userId: activeGame.userId });
        }

        // The resign above only reaches a game the test got as far as recording.
        // A test that fails before that line (e.g. match.found arriving late)
        // still leaves a live game on the server. closeHub() ends every game its
        // sockets can reach and resolves only once that work has been persisted,
        // so nothing below deletes rows underneath a running abandon.
        await closeHub();

        for (const client of openClients) {
            client.terminate();
        }
        await new Promise((resolve) => server.close(resolve));

        // games references users with ON DELETE RESTRICT, so the games go first
        // or the user cleanup below dies on a foreign key.
        await pool.query(`
            DELETE FROM games
             WHERE white_user_id IN (SELECT id FROM users WHERE username LIKE 'QueueTestuser_%')
                OR black_user_id IN (SELECT id FROM users WHERE username LIKE 'QueueTestuser_%')
        `);
        await pool.query("DELETE FROM users WHERE username LIKE 'QueueTestuser_%'");
        await pool.end();
    });



     it('matches two players who asked for the same mode and time control', async () => {
        const idA = await registerPlayer('QueueTestuser_a');
        const idB = await registerPlayer('QueueTestuser_b');

        const a = await connect(accessTokenFor(idA));
        const b = await connect(accessTokenFor(idB));

        const join = JSON.stringify({ type: 'queue.join', mode: 'classic', timeControl: 600000 });
        // Listeners are attached before either send, or a fast reply lands
        // before anything is listening and the test hangs on nothing.
        const events = Promise.all([nextEvent(a), nextEvent(b)]);
        a.send(join);
        b.send(join);

        const [eventA, eventB] = await events;

        expect(eventA.type).toBe('match.found');
        expect(eventB.type).toBe('match.found');
        activeGame = { gameId: eventA.gameId, userId: idA };
        // One game, not two that happen to look alike.
        expect(eventA.gameId).toBe(eventB.gameId);
        // CW-147: match.found carries the mode the game was created with —
        // Android needs it to pick which UI (bar/panel/neither) to show.
        expect(eventA.mode).toBe('classic');
        expect(eventB.mode).toBe('classic');
        //check has legal moves
        expect(eventA.legalMoves).toContain('e2e4');
        expect(eventA.legalMoves).toHaveLength(20);
        // Opposite colours, and each told about the other. These two are what
        // the temporary hardcoded match.found in hub.js cannot satisfy — it
        // tells every player they are white and facing 'Dev Opponent'.
        expect([eventA.color, eventB.color].sort()).toEqual(['black', 'white']);
        expect([eventA.opponent.username, eventB.opponent.username].sort())
            .toEqual(['QueueTestuser_a', 'QueueTestuser_b']);
        // Both sides' clocks start at (essentially) the full time control,
        // re-wired against the new GameManager.js after the merge with Uziel's
        // moves-backend/opponent-move-instantly-backend PRs. Not an exact 600000:
        // real async work (the DB insert, the user lookups) happens between
        // clocks.white.start() and this payload being built, so a few ms of
        // real elapsed time is expected, not a bug.
        for (const clocks of [eventA.clocks, eventB.clocks]) {
            expect(clocks.white).toBeLessThanOrEqual(600000);
            expect(clocks.white).toBeGreaterThan(599000);
            expect(clocks.black).toBeLessThanOrEqual(600000);
            expect(clocks.black).toBeGreaterThan(599000);
        }
    });

    it('leaves a lone player waiting', async () => {
        const id = await registerPlayer('QueueTestuser_solo');
        const solo = await connect(accessTokenFor(id));

        const event = nextEvent(solo);
        solo.send(JSON.stringify({ type: 'queue.join', mode: 'classic', timeControl: 600000 }));

        expect(await event).toBeNull();
    });

    it('does not match players who asked for different time controls', async () => {
        const idFast = await registerPlayer('QueueTestuser_fast');
        const idSlow = await registerPlayer('QueueTestuser_slow');

        const fast = await connect(accessTokenFor(idFast));
        const slow = await connect(accessTokenFor(idSlow));

        const events = Promise.all([nextEvent(fast), nextEvent(slow)]);
        fast.send(JSON.stringify({ type: 'queue.join', mode: 'classic', timeControl: 180000 }));
        slow.send(JSON.stringify({ type: 'queue.join', mode: 'classic', timeControl: 600000 }));

        const [eventFast, eventSlow] = await events;
        expect(eventFast).toBeNull();
        expect(eventSlow).toBeNull();
    });

    // Beyond the ticket's three cases, and the one that justifies mode being in
    // the key at all: a player with an eval bar must never be matched against
    // one without, because that is an advantage rather than a variant.
    it('does not match players who asked for different modes', async () => {
        const idPlain = await registerPlayer('QueueTestuser_plain');
        const idEval = await registerPlayer('QueueTestuser_eval');

        const plain = await connect(accessTokenFor(idPlain));
        const evaluated = await connect(accessTokenFor(idEval));

        const events = Promise.all([nextEvent(plain), nextEvent(evaluated)]);
        plain.send(JSON.stringify({ type: 'queue.join', mode: 'classic', timeControl: 600000 }));
        evaluated.send(JSON.stringify({ type: 'queue.join', mode: 'eval', timeControl: 600000 }));

        const [eventPlain, eventEval] = await events;
        expect(eventPlain).toBeNull();
        expect(eventEval).toBeNull();
    });

    // CW-156. An unrecognised mode must be answered, not queued: keying a
    // waiting list by a typo would leave the player waiting alone forever with
    // no error to explain it (CLAUDE.md, the `mode` decision).
    it('answers an unrecognised mode with queue.rejected instead of queuing it', async () => {
        const id = await registerPlayer('QueueTestuser_bogus_solo');
        const client = await connect(accessTokenFor(id));

        const event = nextEvent(client);
        client.send(JSON.stringify({ type: 'queue.join', mode: 'blitz', timeControl: 600000 }));

        expect(await event).toEqual({
            type: 'queue.rejected',
            error: 'unknown_mode',
            message: expect.stringContaining('blitz'),
        });
    });

    it('never matches two players who both sent the same unrecognised mode', async () => {
        const idA = await registerPlayer('QueueTestuser_bogus_a');
        const idB = await registerPlayer('QueueTestuser_bogus_b');
        const a = await connect(accessTokenFor(idA));
        const b = await connect(accessTokenFor(idB));

        // If the first join had keyed a waiting list by 'blitz', the second
        // would complete a pair and both would get match.found instead.
        const join = JSON.stringify({ type: 'queue.join', mode: 'blitz', timeControl: 600000 });
        const firstA = nextEvent(a);
        a.send(join);
        expect(await firstA).toMatchObject({ type: 'queue.rejected', error: 'unknown_mode' });

        const firstB = nextEvent(b);
        b.send(join);
        expect(await firstB).toMatchObject({ type: 'queue.rejected', error: 'unknown_mode' });

        // And nothing follows the rejection — in particular no late match.found.
        const [laterA, laterB] = await Promise.all([nextEvent(a), nextEvent(b)]);
        expect(laterA).toBeNull();
        expect(laterB).toBeNull();
    });

    // The contract the Android client relies on to leave the queue (CW-157's
    // ghost-queue fix): it has no queue.leave of its own and simply closes its
    // matchmaking socket when Home goes away. The socket closing must take the
    // player out of the waiting list — otherwise a later joiner is matched with
    // someone who is no longer there, which is exactly the bug that was found.
    it('removes a waiting player whose socket closes, so nobody is matched with them', async () => {
        const idLeaver = await registerPlayer('QueueTestuser_leaver');
        const idLater = await registerPlayer('QueueTestuser_later');

        const leaver = await connect(accessTokenFor(idLeaver));
        leaver.send(JSON.stringify({ type: 'queue.join', mode: 'classic', timeControl: 600000 }));
        // No reply is sent to a player who is merely waiting, so wait a moment
        // for the join to be processed before the socket goes.
        await new Promise((resolve) => setTimeout(resolve, 200));

        // A clean close, like the app's: resolves once the closing handshake is
        // done, by which point the server has run its own close handler.
        await new Promise((resolve) => {
            leaver.once('close', resolve);
            leaver.close(1000, 'leaving');
        });

        const later = await connect(accessTokenFor(idLater));
        const event = nextEvent(later);
        later.send(JSON.stringify({ type: 'queue.join', mode: 'classic', timeControl: 600000 }));

        // Waiting, not matched with the player who left.
        expect(await event).toBeNull();
    });
})

// CW-156: the same rule at the queue itself, called directly. Its own
// beforeEach for the same reason as 'rating-based matching' below — a join
// that *did* wrongly queue someone would otherwise leak into the next test.
describe('rejecting an unrecognised mode', () => {
    beforeEach(() => {
        queue.clear();
    });

    it('throws unknown_mode rather than queuing the player', () => {
        let thrown;
        try {
            queue.join({ userId: 'bogus_1', mode: 'blitz', timeControl: 600000, rating: 1000 });
        } catch (err) {
            thrown = err;
        }
        expect(thrown).toBeInstanceOf(queue.InvalidQueueRequestError);
        expect(thrown.code).toBe('unknown_mode');
    });

    it('creates no waiting list for it, so a second player with the same mode is rejected too', () => {
        expect(() =>
            queue.join({ userId: 'bogus_a', mode: 'blitz', timeControl: 600000, rating: 1000 })
        ).toThrow(queue.InvalidQueueRequestError);
        // Had the first join keyed a list by 'blitz', this would return a pair.
        expect(() =>
            queue.join({ userId: 'bogus_b', mode: 'blitz', timeControl: 600000, rating: 1000 })
        ).toThrow(queue.InvalidQueueRequestError);
    });
});

// CW-125: exercises queue.join() directly rather than through a socket. join()
// is synchronous and deliberately free of the database (see the file's own
// header comment) — routing these through the WS/DB-backed harness above
// would mean mixing jest's fake timers with real async DB calls, which is the
// same combination clock.test.js's comment already warns is flaky. Calling
// join() directly is the same shortcut gameManager.test.js takes when it
// calls GameManager.createGame() instead of going through a real queue.join.
//
// This describe is a sibling of 'matchmaking queue' above, not nested inside
// it, so that block's beforeEach(queue.clear()) does not reach here — hence
// this file's own beforeEach. Each test needs to start from a clean queue: a
// join that fails to pair still queues the caller, so leftover state from an
// earlier test would let a later one match by coincidence instead of by the
// behaviour actually being tested.
describe('rating-based matching', () => {
    beforeEach(() => {
        queue.clear();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('matches two players within 100 rating points immediately', () => {
        queue.join({ userId: 'rating_a1', mode: 'classic', timeControl: 600000, rating: 1000 });
        const pair = queue.join({ userId: 'rating_a2', mode: 'classic', timeControl: 600000, rating: 1080 });

        expect(pair).not.toBeNull();
        expect(pair.players.map((p) => p.userId).sort()).toEqual(['rating_a1', 'rating_a2']);
    });

    it('does not match two players 400 rating points apart immediately', () => {
        queue.join({ userId: 'rating_b1', mode: 'classic', timeControl: 600000, rating: 1000 });
        const pair = queue.join({ userId: 'rating_b2', mode: 'classic', timeControl: 600000, rating: 1400 });

        expect(pair).toBeNull();
    });

    // 10s of waiting only widens the window to 100 + 50*1 = 150 — nowhere
    // near enough to cover a 400-point gap.
    it('is not widened enough by 10 seconds of waiting to cover a 400-point gap', () => {
        jest.useFakeTimers();

        queue.join({ userId: 'rating_c1', mode: 'classic', timeControl: 600000, rating: 1000 });
        jest.advanceTimersByTime(10000);
        const pair = queue.join({ userId: 'rating_c2', mode: 'classic', timeControl: 600000, rating: 1400 });

        expect(pair).toBeNull();
    });

    // 60s of waiting widens the window to 100 + 50*6 = 400 — exactly enough
    // to cover the gap this test checks.
    it('widens the window with waiting time until a 400-point gap matches', () => {
        jest.useFakeTimers();

        queue.join({ userId: 'rating_d1', mode: 'classic', timeControl: 600000, rating: 1000 });
        jest.advanceTimersByTime(60000);
        const pair = queue.join({ userId: 'rating_d2', mode: 'classic', timeControl: 600000, rating: 1400 });

        expect(pair).not.toBeNull();
        expect(pair.players.map((p) => p.userId).sort()).toEqual(['rating_d1', 'rating_d2']);
    });

    // Locks in oldest-qualifying-first, not closest-rating-first. e1 (1000)
    // and e2 (1200) queue 200 points apart — too far to match each other —
    // so both are still waiting when e3 (1100) arrives, exactly 100 from
    // each of them. e3 must match e1, the older of the two, even though
    // both are equally eligible. A second join (e4, 1200) then proves e2
    // was left waiting rather than matched or dropped.
    it('matches the oldest eligible waiter first when more than one qualifies', () => {
        queue.join({ userId: 'rating_e1', mode: 'classic', timeControl: 600000, rating: 1000 });
        queue.join({ userId: 'rating_e2', mode: 'classic', timeControl: 600000, rating: 1200 });

        const pairWithE3 = queue.join({ userId: 'rating_e3', mode: 'classic', timeControl: 600000, rating: 1100 });
        expect(pairWithE3).not.toBeNull();
        expect(pairWithE3.players.map((p) => p.userId).sort()).toEqual(['rating_e1', 'rating_e3']);

        const pairWithE4 = queue.join({ userId: 'rating_e4', mode: 'classic', timeControl: 600000, rating: 1200 });
        expect(pairWithE4).not.toBeNull();
        expect(pairWithE4.players.map((p) => p.userId).sort()).toEqual(['rating_e2', 'rating_e4']);
    });

    // f1 queued first but is outside the window for f3; f2 queued after and
    // is inside it. The scan must skip the ineligible-but-older f1 and match
    // the eligible-but-younger f2. A second join (f4, matching f1's rating)
    // then proves f1 was skipped rather than removed or matched by mistake.
    it('skips an ineligible older waiter and matches the first eligible one', () => {
        queue.join({ userId: 'rating_f1', mode: 'classic', timeControl: 600000, rating: 1000 });
        queue.join({ userId: 'rating_f2', mode: 'classic', timeControl: 600000, rating: 1300 });

        const pairWithF3 = queue.join({ userId: 'rating_f3', mode: 'classic', timeControl: 600000, rating: 1300 });
        expect(pairWithF3).not.toBeNull();
        expect(pairWithF3.players.map((p) => p.userId).sort()).toEqual(['rating_f2', 'rating_f3']);

        const pairWithF4 = queue.join({ userId: 'rating_f4', mode: 'classic', timeControl: 600000, rating: 1000 });
        expect(pairWithF4).not.toBeNull();
        expect(pairWithF4.players.map((p) => p.userId).sort()).toEqual(['rating_f1', 'rating_f4']);
    });
});

