const http = require('http');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const app = require('../src/app');
const pool = require('../src/db/pool');
const queue = require('../src/matchmaking/queue');
const { attachHub, closeHub } = require('../src/ws/hub');
const GameManager = require('../src/game/GameManager');
const gamesRepo = require('../src/db/repositories/games.repo');
const usersRepo = require('../src/db/repositories/users.repo');

// Pins the parts of a human-vs-human game that existing tests check only loosely,
// so a later change that touches the game-end path cannot alter them unnoticed:
// game.end's exact shape for both players (moves.test.js matches only result and
// reason), and the hub ignoring a message type it does not know.

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

// Same buffered, strictly ordered stream as moves.test.js.
function connect(token) {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    client.events = [];
    client.cursor = 0;
    client.waiters = [];
    client.on('message', (raw) => {
        client.events.push(JSON.parse(raw));
        for (const wake of client.waiters.splice(0)) wake();
    });
    openClients.push(client);

    return new Promise((resolve, reject) => {
        client.on('open', () => resolve(client));
        client.on('error', reject);
    });
}

function take(client, timeoutMs = 1000) {
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

async function matchedPair(prefix) {
    const a = await connect(accessTokenFor(await registerPlayer(`${prefix}_a`)));
    const b = await connect(accessTokenFor(await registerPlayer(`${prefix}_b`)));

    const join = JSON.stringify({ type: 'queue.join', mode: 'classic', timeControl: 600000 });
    const events = Promise.all([take(a), take(b)]);
    a.send(join);
    b.send(join);
    const [eventA, eventB] = await events;
    expect(eventA.type).toBe('match.found');
    expect(eventB.type).toBe('match.found');

    const white = eventA.color === 'white' ? a : b;
    const black = eventA.color === 'white' ? b : a;
    activeGames.push(eventA.gameId);
    return { white, black, gameId: eventA.gameId };
}

async function commitMove({ white, black, gameId, uci, mover }) {
    const both = Promise.all([take(white), take(black)]);
    mover.send(JSON.stringify({ type: 'game.move', gameId, uci }));
    const [whiteEvent, blackEvent] = await both;
    expect(whiteEvent).toMatchObject({ type: 'move.committed', uci });
    expect(blackEvent).toMatchObject({ type: 'move.committed', uci });
}

// The database side of a rated ending. No polling: endGame commits its
// transaction before it sends game.end, so by the time a test has read both
// events every write has landed. Colours come from the row, not from the test.
async function expectRatedInDb(gameId, { result, reason, whiteAfter, blackAfter }) {
    const row = await gamesRepo.findById(gameId);
    expect(row).toMatchObject({ result, reason });

    const [whiteUser, blackUser] = await Promise.all([
        usersRepo.findById(row.white_user_id),
        usersRepo.findById(row.black_user_id),
    ]);
    expect(whiteUser.rating).toBe(whiteAfter);
    expect(blackUser.rating).toBe(blackAfter);

    const history = (await pool.query(
        'SELECT user_id, rating_before, rating_after FROM rating_history WHERE game_id = $1',
        [gameId]
    )).rows;
    expect(history).toHaveLength(2);
    const whiteHistory = history.find((r) => String(r.user_id) === String(row.white_user_id));
    const blackHistory = history.find((r) => String(r.user_id) === String(row.black_user_id));
    expect(whiteHistory).toMatchObject({ rating_before: 1000, rating_after: whiteAfter });
    expect(blackHistory).toMatchObject({ rating_before: 1000, rating_after: blackAfter });
}

async function deleteTestUsers() {
    await pool.query(`
        DELETE FROM games
         WHERE white_user_id IN (SELECT id FROM users WHERE username LIKE 'HumanGameTestuser_%')
            OR black_user_id IN (SELECT id FROM users WHERE username LIKE 'HumanGameTestuser_%')
    `);
    await pool.query("DELETE FROM users WHERE username LIKE 'HumanGameTestuser_%'");
}

describe('human-vs-human game: characterisation', () => {
    beforeAll(async () => {
        await deleteTestUsers();
        server = http.createServer(app);
        attachHub(server);
        await new Promise((resolve) => server.listen(0, resolve));
        port = server.address().port;
    });

    beforeEach(() => {
        queue.clear();
    });

    afterAll(async () => {
        // Same teardown as moves.test.js: end anything still live through
        // GameManager first, so no abandon races the DELETEs below.
        for (const gameId of activeGames) {
            const live = GameManager.get(gameId);
            if (!live) continue;
            await GameManager.resign({ gameId, userId: live.whiteUserId });
        }
        await closeHub();
        for (const client of openClients) client.terminate();
        await new Promise((resolve) => server.close(resolve));
        await deleteTestUsers();
        await pool.end();
    });

    // toEqual, not toMatchObject: the exact key set is the contract. Both
    // players are new (1000, zero rated games), so the swing is the ±16 that
    // elo.test.js pins for equal ratings under 30 games.
    it('sends each player a game.end with their own newRating and ratingDelta on checkmate', async () => {
        const { white, black, gameId } = await matchedPair('HumanGameTestuser_mate');

        await commitMove({ white, black, gameId, uci: 'f2f3', mover: white });
        await commitMove({ white, black, gameId, uci: 'e7e5', mover: black });
        await commitMove({ white, black, gameId, uci: 'g2g4', mover: white });
        await commitMove({ white, black, gameId, uci: 'd8h4', mover: black });

        const [whiteEnd, blackEnd] = await Promise.all([take(white), take(black)]);
        expect(whiteEnd).toEqual({
            type: 'game.end', result: '0-1', reason: 'checkmate', newRating: 984, ratingDelta: -16,
        });
        expect(blackEnd).toEqual({
            type: 'game.end', result: '0-1', reason: 'checkmate', newRating: 1016, ratingDelta: 16,
        });
        await expectRatedInDb(gameId, {
            result: '0-1', reason: 'checkmate', whiteAfter: 984, blackAfter: 1016,
        });
    });

    it('sends the same shape to both players, the resigner included, on resignation', async () => {
        const { white, black, gameId } = await matchedPair('HumanGameTestuser_resign');

        const ends = Promise.all([take(white), take(black)]);
        white.send(JSON.stringify({ type: 'game.resign', gameId }));
        const [whiteEnd, blackEnd] = await ends;

        expect(whiteEnd).toEqual({
            type: 'game.end', result: '0-1', reason: 'resign', newRating: 984, ratingDelta: -16,
        });
        expect(blackEnd).toEqual({
            type: 'game.end', result: '0-1', reason: 'resign', newRating: 1016, ratingDelta: 16,
        });
        await expectRatedInDb(gameId, {
            result: '0-1', reason: 'resign', whiteAfter: 984, blackAfter: 1016,
        });
    });

    // A newer client may send event types this server does not know. They must
    // be ignored — no reply, no error logged, socket left open and still usable.
    it('ignores an unknown message type and keeps the socket usable', async () => {
        const id = await registerPlayer('HumanGameTestuser_unknown');
        const client = await connect(accessTokenFor(id));

        client.send(JSON.stringify({ type: 'no.such.event', gameId: 'x' }));
        expect(await take(client, 300)).toBeNull();
        expect(client.readyState).toBe(WebSocket.OPEN);

        // Still served afterwards: a bad mode is answered rather than queued.
        client.send(JSON.stringify({ type: 'queue.join', mode: 'blitz', timeControl: 600000 }));
        expect(await take(client)).toMatchObject({ type: 'queue.rejected', error: 'unknown_mode' });
    });
});
