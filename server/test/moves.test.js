const http = require('http');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const app = require('../src/app');
const pool = require('../src/db/pool');
const queue = require('../src/matchmaking/queue');
const { attachHub } = require('../src/ws/hub');
const gamesRepo = require('../src/db/repositories/games.repo');
const usersRepo = require('../src/db/repositories/users.repo');
const GameManager = require('../src/game/GameManager');
const { expectServerError } = require('./helpers/serverErrors');



function accessTokenFor(userId) {
    return jwt.sign({ sub: String(userId) }, process.env.JWT_SECRET, {
        algorithm: 'HS256',
        expiresIn: '15m',
    });
}

let server;
let port;
const openClients = [];
const activeGames = [];

function connect(token) {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: { Authorization: `Bearer ${token}` },
    });

    // The socket's real stream, recorded in arrival order by one permanent
    // listener attached before the socket opens. The previous helpers attached a
    // listener per read instead, which meant an event arriving while nothing was
    // waiting was dropped, and an event arriving while something *was* waiting
    // satisfied that read whoever it belonged to. `move.committed` is broadcast
    // to both players, so "the next message on my socket" is not "the reply to
    // my move" — white receives black's commits too.
    client.events = [];
    // How much of `events` the test has consumed. Reads are strictly in order
    // and never skip: `events` is append-only, and the cursor only moves
    // forward, so a stale or unexpected event is handed to the test and fails
    // its assertion rather than being searched past.
    client.cursor = 0;
    client.waiters = [];
    client.on('message', (raw) => {
        client.events.push(JSON.parse(raw));
        // Woken in the same tick the event is buffered, and by the recorder
        // itself rather than by a second 'message' listener. That is what makes
        // take() below race-free: a waiter can never be parked while an
        // unconsumed event already sits in the buffer.
        for (const wake of client.waiters.splice(0)) wake();
    });
    openClients.push(client);

    return new Promise((resolve, reject) => {
        client.on('open', () => resolve(client));
        client.on('error', reject);
    });
}


// The next unconsumed event on this socket, or null if none arrives in time.
// Advances the cursor by exactly one: no matching, no searching. The caller
// asserts what it got, so an event the test did not expect surfaces as a failed
// assertion instead of being silently skipped.
function take(client, timeoutMs = 1000) {
    // Synchronous fast path. Checked in the same uninterrupted stretch as the
    // registration below, so nothing can arrive in between.
    if (client.cursor < client.events.length) {
        return Promise.resolve(client.events[client.cursor++]);
    }

    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            client.waiters = client.waiters.filter((w) => w !== attempt);
            resolve(null);
        }, timeoutMs);

        function attempt() {
            if (client.cursor >= client.events.length) {
                // Another take() on this socket was woken by the same event and
                // consumed it first. Keep waiting rather than resolving empty.
                client.waiters.push(attempt);
                return;
            }
            clearTimeout(timer);
            resolve(client.events[client.cursor++]);
        }

        client.waiters.push(attempt);
    });
}

async function registerPlayer(username) {
    const res = await request(app)
        .post('/api/auth/register')
        .send({ username, password: 'a-strong-password-123' });
    expect(res.status).toBe(201);
    return res.body.userId;
}



// Two registered players, connected, queued and matched — returned already
// labelled by colour, because every test below needs to know which socket may
// legitimately move first. Colours are assigned by a coin flip in GameManager,
// so they cannot be assumed from the order the players joined.
async function matchedPair(prefix) {
    const idA = await registerPlayer(`${prefix}_a`);
    const idB = await registerPlayer(`${prefix}_b`);

    const a = await connect(accessTokenFor(idA));
    const b = await connect(accessTokenFor(idB));

    const join = JSON.stringify({ type: 'queue.join', mode: 'classic', timeControl: 600000 });
    const events = Promise.all([take(a), take(b)]);
    a.send(join);
    b.send(join);
    const [eventA, eventB] = await events;

    // Both are consumed, so both are checked: an unexpected first event on
    // either socket must fail here rather than be read as a match.
    expect(eventA.type).toBe('match.found');
    expect(eventB.type).toBe('match.found');

    const white = eventA.color === 'white' ? a : b;
    const black = eventA.color === 'white' ? b : a;
    activeGames.push({ gameId: eventA.gameId, white, black });
    return { white, black, gameId: eventA.gameId };
}


// Plays one move and consumes the resulting move.committed from *both* players,
// asserting each is the commit for this move. move.committed is a broadcast, so
// draining only the mover would leave the opponent's copy unread, and the next
// strict read from that socket would take the leftover.
async function commitMove({ white, black, gameId, uci, mover }) {
    const both = Promise.all([take(white), take(black)]);
    mover.send(JSON.stringify({ type: 'game.move', gameId, uci }));
    const [whiteEvent, blackEvent] = await both;

    expect(whiteEvent).toMatchObject({ type: 'move.committed', uci });
    expect(blackEvent).toMatchObject({ type: 'move.committed', uci });
}


// Sends a move and returns the next event on the mover's socket — whatever it
// is. It deliberately does not go looking for this move's own commit: the caller
// asserts on what came back, so a stale event is a failure rather than something
// this helper quietly steps over.
function move(client, gameId, uci) {
    const event = take(client);
    client.send(JSON.stringify({ type: 'game.move', gameId, uci }));
    return event;
}




// Run before as well as after, as privacy.test.js and evaluation.test.js do: a
// run that dies part-way never reaches its afterAll, and the rows it leaves
// behind make the next run's registrations collide on username (409).
// moves cascades from games, so deleting the games takes the moves with it. The
// games still have to go before the users, which do not cascade.
async function deleteTestUsers() {
    await pool.query(`
        DELETE FROM games
         WHERE white_user_id IN (SELECT id FROM users WHERE username LIKE 'MovesTestuser_%')
            OR black_user_id IN (SELECT id FROM users WHERE username LIKE 'MovesTestuser_%')
    `);
    await pool.query("DELETE FROM users WHERE username LIKE 'MovesTestuser_%'");
}

describe('game.move', () => {

    beforeAll(async () => {
        await deleteTestUsers();
        server = http.createServer(app);
        attachHub(server);
        await new Promise((resolve) => server.listen(0, resolve));
        port = server.address().port;
    });

    beforeEach(() => {
        // Module state is a singleton and outlives each test — a player left
        // waiting by one test would be matched by the next one's join.
        queue.clear();
    });

    afterAll(async () => {
        // Five of the tests above deliberately leave their game unfinished
        // (one move, no resign/checkmate/abandon). Terminating those sockets
        // below fires hub.js's fire-and-forget gameManager.abandon() for each
        // one, racing the DELETE/pool.end() calls that follow — the second,
        // dominant source of the abandon-on-disconnect race (the first being
        // GameManager.endGame's own persist/broadcast ordering, fixed there).
        // Resigning here first, and awaiting it, means each one is already fully
        // persisted by the time we get to teardown. Already-ended games
        // (checkmate/resign/abandon tests) are skipped — GameManager has already
        // removed them from its live map.
        //
        // Ended through GameManager rather than over a socket, which is how
        // privacy.test.js already does it. Two reasons. It resolves only once
        // every write endGame makes has finished, where the socket version
        // awaited a *reply* and so continued on a 1000ms timeout whether the
        // resign had been processed or not — the error gate caught that escape
        // hatch letting `game.resign failed: Cannot use a pool after calling end
        // on the pool` through. And it reads no stream, which matters now that
        // reads are strictly in order: these sockets legitimately hold
        // unconsumed broadcasts (their tests only ever read the mover's socket),
        // so a strict read here would take a stale commit instead of the ending.
        for (const { gameId } of activeGames) {
            const live = GameManager.get(gameId);
            if (!live) continue;
            await GameManager.resign({ gameId, userId: live.whiteUserId });
        }

        for (const client of openClients) {
            client.terminate();
        }
        await new Promise((resolve) => server.close(resolve));

        await deleteTestUsers();
        await pool.end();
    });

    it('accepts a legal move and returns the new position', async () => {
        const { white, gameId } = await matchedPair('MovesTestuser_legal');

        // A measurable real delay so white's clock has actually ticked down by
        // the time the move commits — otherwise elapsed time could be ~0ms and
        // the clocks assertion below would be indistinguishable from a bug that
        // never reads a live clock at all.
        await new Promise((resolve) => setTimeout(resolve, 50));
        const event = await move(white, gameId, 'e2e4');

        expect(event.type).toBe('move.committed');
        expect(event.uci).toBe('e2e4');
        // Asserted in pieces rather than as one FEN string: the en passant field
        // is where chess.js versions differ, and pinning the whole thing would
        // make this fail on an upgrade that changed nothing that matters.
        expect(event.fen).toContain('4P3');
        expect(event.fen.split(' ')[1]).toBe('b');
        // White moved, so white's clock paused with over 50ms visibly spent
        // (the artificial delay above). Black's clock only just started — a
        // few ms of real elapsed time before this payload was built is
        // expected (the DB insert happens in between), not exactly 600000.
        expect(event.clocks.white).toBeLessThan(600000 - 50);
        expect(event.clocks.black).toBeLessThanOrEqual(600000);
        expect(event.clocks.black).toBeGreaterThan(599000);
    });

     // The three below all assert silence, and silence on its own proves nothing —
    // a server that never answered anything would pass. So each one follows up by
    // playing a legal first move: e2e4 only succeeds if the game never advanced.

    it('ignores an illegal move and leaves the position unchanged', async () => {
        const { white, gameId } = await matchedPair('MovesTestuser_illegal');

        // Refusing the move is only half of it — applyMove is also expected to
        // say why it refused. Declaring the log line asserts that it does, and
        // keeps this deliberate error out of the unexpected-error gate.
        expectServerError(/^game\.move illegal:/);
        expect(await move(white, gameId, 'e2e5')).toBeNull();

        const accepted = await move(white, gameId, 'e2e4');
        expect(accepted.type).toBe('move.committed');
    });

    it('ignores a move sent by the player whose turn it is not', async () => {
        const { white, black, gameId } = await matchedPair('MovesTestuser_turn');

        // e2e4 is legal in this position, so a server that only validated
        // against the board would commit it. Only comparing the sender against
        // the side to move catches this — which is why it cannot be tested
        // against Game.js alone.
        expectServerError(/^game\.move out of turn:/);
        expect(await move(black, gameId, 'e2e4')).toBeNull();

        const accepted = await move(white, gameId, 'e2e4');
        expect(accepted.type).toBe('move.committed');
    });

     it('ignores a move from someone who is not a player in the game', async () => {
        const { white, gameId } = await matchedPair('MovesTestuser_stranger');

        const outsiderId = await registerPlayer('MovesTestuser_outsider');
        const outsider = await connect(accessTokenFor(outsiderId));

        // Neither illegal nor out of turn — e2e4 is legal and it is white's
        // turn. Only membership of the game rejects this, and nothing else here
        // would catch a server that skipped that check.
        expectServerError(/^game\.move from a non-participant:/);
        expect(await move(outsider, gameId, 'e2e4')).toBeNull();

        const accepted = await move(white, gameId, 'e2e4');
        expect(accepted.type).toBe('move.committed');
    });

     // CW-52. moves.test.js otherwise only ever listens on the mover's socket,
    // so nothing proves the opponent gets their copy — which is the whole point
    // of the story. The broadcast already exists in applyMove, so this passes
    // immediately rather than going red first.
    it('delivers the move to the opponent as well as the mover', async () => {
        const { white, black, gameId } = await matchedPair('MovesTestuser_broadcast');

        // Both reads are set up before the send. With the buffered stream this is
        // no longer load-bearing — an event arriving first is recorded and taken
        // afterwards — but it keeps the two reads symmetric.
        const events = Promise.all([take(white), take(black)]);
        white.send(JSON.stringify({ type: 'game.move', gameId, uci: 'e2e4' }));
        const [moverEvent, opponentEvent] = await events;

        expect(opponentEvent.type).toBe('move.committed');
        // The same event, not two that happen to look alike — the opponent must
        // never be rendering a position built separately from the mover's.
        expect(opponentEvent.uci).toBe(moverEvent.uci);
        expect(opponentEvent.fen).toBe(moverEvent.fen);
        expect(opponentEvent.legalMoves).toEqual(moverEvent.legalMoves);

        // And the list belongs to whoever is to move, not to whoever received
        // it: after e2e4 both players get black's moves. That is what lets the
        // client gate input on the FEN's side-to-move rather than on the list.
        expect(opponentEvent.legalMoves).toContain('e7e5');
    });

    it('ends the game when a move delivers checkmate', async () => {
        const { white, black, gameId } = await matchedPair('MovesTestuser_mate');

        // Fool's mate — the shortest checkmate in chess, four half-moves. Short
        // enough to play through the socket, so this exercises the real path
        // rather than a position constructed behind GameManager's back.
        //
        // Both sockets consume and check every commit, not just the mover's.
        // move.committed is a broadcast, so a move that only drained the mover
        // would leave the opponent's copy unread, and the next strict read from
        // that socket would take the leftover instead of what it was waiting for
        // — the exact confusion that made this test flaky.
        await commitMove({ white, black, gameId, uci: 'f2f3', mover: white });
        await commitMove({ white, black, gameId, uci: 'e7e5', mover: black });
        await commitMove({ white, black, gameId, uci: 'g2g4', mover: white });

        // Black delivers the mate. Both players get the commit and then the
        // ending, and the ordering is asserted by consuming the stream in order:
        // the commit has to be the next event on each socket, and the ending the
        // one after it.
        const commits = Promise.all([take(white), take(black)]);
        black.send(JSON.stringify({ type: 'game.move', gameId, uci: 'd8h4' }));
        const [whiteCommit, blackCommit] = await commits;
        expect(whiteCommit).toMatchObject({ type: 'move.committed', uci: 'd8h4' });
        expect(blackCommit).toMatchObject({ type: 'move.committed', uci: 'd8h4' });

        const [whiteEnd, blackEnd] = await Promise.all([take(white), take(black)]);
        // Black mated, so black wins. PGN notation, matching games.result's CHECK.
        // Both are asserted: neither player may be told something different, and
        // consuming one without checking it would be exactly the blind spot this
        // rewrite removes. result/reason are the two fields that must agree —
        // newRating/ratingDelta legitimately differ per player.
        expect(whiteEnd).toMatchObject({ type: 'game.end', result: '0-1', reason: 'checkmate' });
        expect(blackEnd).toMatchObject({ type: 'game.end', result: '0-1', reason: 'checkmate' });
    });

    it('ends the game when a player resigns', async () => {
        const { white, black, gameId } = await matchedPair('MovesTestuser_resign');

        // No move.committed here — resignation is not a move, so the opponent
        // receives game.end on its own.
        const ended = take(black);
        white.send(JSON.stringify({ type: 'game.resign', gameId }));

        const event = await ended;
        expect(event.type).toBe('game.end');
        // The resigner loses, so white resigning is a win for black.
        expect(event.result).toBe('0-1');
        expect(event.reason).toBe('resign');
    });

    it('ends the game as a loss for whoever disconnects mid-game', async () => {
        const { white, black, gameId } = await matchedPair('MovesTestuser_abandon');

        // Regression for the abandon-on-disconnect race: hub.js's disconnect
        // handler logs any abandon()/endGame() failure under this exact
        // message. The old broadcast-before-persist ordering let game.end
        // reach the client before the DB writes it depends on had committed,
        // which is what let test cleanup (and, in principle, anything else
        // racing the DB) surface as this log line.
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        // terminate(), not close(): this stands in for a crash/force-stop/lost
        // network, not a graceful leave — the abrupt case the disconnect
        // handler exists for. Either way the server sees a 'close' event.
        const ended = take(black);
        white.terminate();

        const event = await ended;
        expect(event.type).toBe('game.end');
        // Whoever disconnected loses, so white dropping is a win for black.
        expect(event.result).toBe('0-1');
        expect(event.reason).toBe('abandoned');

        // The event above must only ever arrive after persistence commits, not
        // before it — so by now the DB already agrees with what the client
        // was just told.
        const row = await gamesRepo.findById(gameId);
        expect(row.result).toBe('0-1');
        expect(row.reason).toBe('abandoned');

        // Equal starting ratings (1000), zero rated games each, decisive
        // result — same ±16 magnitude as GameManager's timeout test.
        const whiteUser = await usersRepo.findById(row.white_user_id);
        const blackUser = await usersRepo.findById(row.black_user_id);
        expect(whiteUser.rating).toBe(984);
        expect(blackUser.rating).toBe(1016);

        const historyRows = (await pool.query(
            'SELECT user_id FROM rating_history WHERE game_id = $1',
            [gameId]
        )).rows;
        expect(historyRows).toHaveLength(2);

        expect(errorSpy).not.toHaveBeenCalledWith(
            'abandon-on-disconnect failed:',
            expect.anything()
        );
        errorSpy.mockRestore();
    });

})