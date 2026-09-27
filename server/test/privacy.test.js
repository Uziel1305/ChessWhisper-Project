const http = require('http');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const app = require('../src/app');
const pool = require('../src/db/pool');
const { attachHub, closeHub } = require('../src/ws/hub');
const queue = require('../src/matchmaking/queue');
const engineClient = require('../src/engine/engineClient');
const GameManager = require('../src/game/GameManager');

// Only the engine is mocked. The hub, the sockets and GameManager are the real
// ones: this file is about who a message is *addressed to*, and a spy on
// sendToUser would test GameManager's intent rather than what actually arrives
// on a player's socket.
jest.mock('../src/engine/engineClient');

function accessTokenFor(userId) {
    return jwt.sign({ sub: String(userId) }, process.env.JWT_SECRET, {
        algorithm: 'HS256',
        expiresIn: '15m',
    });
}

let server;
let port;
const openClients = [];

// Every message the socket receives, in arrival order. Attached before the
// socket opens, so nothing can slip past between 'open' and the first read.
function connect(userId) {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: { Authorization: `Bearer ${accessTokenFor(userId)}` },
    });
    client.events = [];
    client.on('message', (raw) => client.events.push(JSON.parse(raw)));
    openClients.push(client);

    return new Promise((resolve, reject) => {
        client.on('open', () => resolve(client));
        client.on('error', reject);
    });
}

function eventsOf(client, type) {
    return client.events.filter((event) => event.type === type);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Resolves true as soon as the condition holds, false if it never does. Returns
// rather than throws so the assertion that follows can show what actually
// arrived instead of a bare timeout.
async function waitFor(condition, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await condition()) return true;
        await sleep(10);
    }
    return false;
}

async function registerPlayer(username) {
    const res = await request(app)
        .post('/api/auth/register')
        .send({ username, password: 'a-strong-password-123' });
    expect(res.status).toBe(201);
    return res.body.userId;
}

// Run before as well as after: a run that dies part-way never reaches its
// afterAll, and the rows it leaves behind would make the next run's
// registrations collide on username. games references users with ON DELETE
// RESTRICT, so the games go first; their feedback rows cascade with them.
async function deleteTestUsers() {
    await pool.query(`
        DELETE FROM games
         WHERE white_user_id IN (SELECT id FROM users WHERE username LIKE 'PrivacyTestuser_%')
            OR black_user_id IN (SELECT id FROM users WHERE username LIKE 'PrivacyTestuser_%')
    `);
    await pool.query("DELETE FROM users WHERE username LIKE 'PrivacyTestuser_%'");
}

// Four plies of an ordinary opening — nobody is mated, so the game stays live.
const MOVES = ['e2e4', 'e7e5', 'g1f3', 'b8c6'];
// White-perspective engine answers, one per ply. Read as a game:
//   ply 1 white  +30            (no verdict: nothing before it)
//   ply 2 black  30 -> 90       black lost 60   (the eval rose, which is bad for black)
//   ply 3 white  90 -> 40       white lost 50
//   ply 4 black  40 -> 400      black lost 360
// Three different non-zero losses, so a verdict delivered to the wrong player
// or carrying the wrong figure cannot pass by coincidence.
const EVALS = [30, 90, 40, 400];
// How long to keep listening after every expected event has arrived. A "zero"
// over a real socket can only be shown by waiting, so this bounds it.
const SETTLE_MS = 300;

describe('feedback privacy', () => {
    let gameId;

    beforeAll(async () => {
        await deleteTestUsers();
        server = http.createServer(app);
        attachHub(server);
        await new Promise((resolve) => server.listen(0, resolve));
        port = server.address().port;
    });

    beforeEach(() => {
        queue.clear();
        gameId = undefined;
        engineClient.evaluate.mockReset();
        // Same { cp, mateIn } shape engineClient.evaluate() resolves.
        EVALS.forEach((cp) => engineClient.evaluate.mockResolvedValueOnce({ cp, mateIn: null }));
    });

    afterEach(async () => {
        // Ends the game through GameManager rather than over a socket, so this
        // resolves only once every write endGame makes has finished, and it
        // stops the clocks even when the test failed part-way.
        const live = gameId && GameManager.get(gameId);
        if (live) {
            await GameManager.resign({ gameId, userId: live.whiteUserId });
        }
    });

    afterAll(async () => {
        // afterEach resigns the game a test recorded; closeHub() ends and drains
        // anything it missed (a test that failed before setting gameId) before
        // any row is deleted.
        await closeHub();
        for (const client of openClients) {
            client.terminate();
        }
        await new Promise((resolve) => server.close(resolve));
        await deleteTestUsers();
        await pool.end();
    });

    it('sends move.feedback to the player who made the move and to nobody else', async () => {
        const idA = await registerPlayer('PrivacyTestuser_a');
        const idB = await registerPlayer('PrivacyTestuser_b');
        const a = await connect(idA);
        const b = await connect(idB);

        const join = JSON.stringify({ type: 'queue.join', mode: 'feedback', timeControl: 600000 });
        a.send(join);
        b.send(join);
        expect(await waitFor(() =>
            eventsOf(a, 'match.found').length === 1 && eventsOf(b, 'match.found').length === 1
        )).toBe(true);

        // Colours are coin-flipped, so read them rather than assuming.
        const matchA = eventsOf(a, 'match.found')[0];
        gameId = matchA.gameId;
        const white = matchA.color === 'white' ? a : b;
        const black = white === a ? b : a;

        // One move at a time, waiting for both boards to show it before the
        // next is sent, so the engine is asked about the plies in order.
        for (let i = 0; i < MOVES.length; i++) {
            (i % 2 === 0 ? white : black).send(
                JSON.stringify({ type: 'game.move', gameId, uci: MOVES[i] })
            );
            expect(await waitFor(() =>
                eventsOf(white, 'move.committed').length === i + 1
                && eventsOf(black, 'move.committed').length === i + 1
            )).toBe(true);
        }

        // Wait for what the movers should get, then keep listening a little
        // longer: anything the wrong player is sent lands in this window.
        await waitFor(() =>
            eventsOf(white, 'move.feedback').length >= 1
            && eventsOf(black, 'move.feedback').length >= 2
        );
        await sleep(SETTLE_MS);

        // Routing. Each socket sees feedback only for plies its own player
        // moved: black moved plies 2 and 4, white moved ply 3, and ply 1 has no
        // verdict. A verdict sent to the opponent would add a ply to the other
        // list, so the opponent receiving zero is exactly what these prove. The
        // mover assertions are what stop "zero" passing merely because no
        // move.feedback is ever sent.
        expect(eventsOf(white, 'move.feedback').map((e) => e.ply)).toEqual([3]);
        expect(eventsOf(black, 'move.feedback').map((e) => e.ply)).toEqual([2, 4]);

        // Payload. classification only has to be present here — its exact
        // values belong to classification.test.js. cpLoss is checked exactly:
        // a non-negative integer number of centipawns, per the approved contract.
        expect(eventsOf(white, 'move.feedback')).toMatchObject([
            { type: 'move.feedback', ply: 3, classification: expect.any(String), cpLoss: 50 },
        ]);
        expect(eventsOf(black, 'move.feedback')).toMatchObject([
            { type: 'move.feedback', ply: 2, classification: expect.any(String), cpLoss: 60 },
            { type: 'move.feedback', ply: 4, classification: expect.any(String), cpLoss: 360 },
        ]);
    }, 15000);
});
