const http = require('http');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const app = require('../src/app');
const pool = require('../src/db/pool');
const { attachHub, closeHub } = require('../src/ws/hub');
const gamesRepo = require('../src/db/repositories/games.repo');
const GameManager = require('../src/game/GameManager');

// closeHub() is the one point at which work started by a socket event can be
// waited for. These tests assert on the database immediately after it resolves,
// with no sleep and no reply read in between: if closeHub() resolved before
// that work had finished, the rows would not be there yet.
//
// The hub is a module-level singleton and closeHub() closes it for good, so the
// test that calls it runs last in this file. Jest gives each file its own
// module registry, so no other suite sees a closed hub.

function accessTokenFor(userId) {
    return jwt.sign({ sub: String(userId) }, process.env.JWT_SECRET, {
        algorithm: 'HS256',
        expiresIn: '15m',
    });
}

let server;
let port;
const openClients = [];

// Same buffered, strictly ordered stream as moves.test.js: one permanent
// recorder per socket, and take() hands back the next unconsumed event.
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
    return { gameId: eventA.gameId };
}

// Run before as well as after: a run that dies part-way never reaches its
// afterAll, and its rows would make the next run's registrations collide.
// games references users without a cascade, so the games go first.
async function deleteTestUsers() {
    await pool.query(`
        DELETE FROM games
         WHERE white_user_id IN (SELECT id FROM users WHERE username LIKE 'HubTestuser_%')
            OR black_user_id IN (SELECT id FROM users WHERE username LIKE 'HubTestuser_%')
    `);
    await pool.query("DELETE FROM users WHERE username LIKE 'HubTestuser_%'");
}

describe('closeHub', () => {
    beforeAll(async () => {
        await deleteTestUsers();
        server = http.createServer(app);
        attachHub(server);
        await new Promise((resolve) => server.listen(0, resolve));
        port = server.address().port;
    });

    afterAll(async () => {
        // closeHub() is idempotent, so this is safe whether or not a test got
        // as far as calling it — and if one failed first, it still drains.
        await closeHub();
        for (const client of openClients) {
            client.terminate();
        }
        await new Promise((resolve) => server.close(resolve));
        await deleteTestUsers();
        await pool.end();
    });

    it('resolves only after the abandon started by closing a live game has been persisted', async () => {
        const { gameId } = await matchedPair('HubTestuser_drain');
        expect(GameManager.get(gameId)).toBeDefined();

        await closeHub();

        // No wait, no event read: the abandon ran inside closeHub().
        expect(GameManager.get(gameId)).toBeUndefined();

        const row = await gamesRepo.findById(gameId);
        expect(row.reason).toBe('abandoned');
        // Which player's socket closed first decides who lost, so only that
        // there is a result is asserted, not which one.
        expect(['1-0', '0-1']).toContain(row.result);

        const history = (await pool.query(
            'SELECT user_id FROM rating_history WHERE game_id = $1',
            [gameId]
        )).rows;
        expect(history).toHaveLength(2);
    });

    it('refuses new connections once closed, and a second closeHub() resolves too', async () => {
        await expect(closeHub()).resolves.toBeUndefined();

        const client = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
            headers: { Authorization: `Bearer ${accessTokenFor(1)}` },
        });
        openClients.push(client);
        const outcome = await new Promise((resolve) => {
            client.on('open', () => resolve('open'));
            client.on('error', () => resolve('refused'));
        });
        expect(outcome).toBe('refused');
    });
});
