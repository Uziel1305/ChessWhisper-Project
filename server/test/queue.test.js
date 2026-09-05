const http = require('http');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const app = require('../src/app');
const pool = require('../src/db/pool');
const { attachHub } = require('../src/ws/hub');
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
        // One game, not two that happen to look alike.
        expect(eventA.gameId).toBe(eventB.gameId);
        // Opposite colours, and each told about the other. These two are what
        // the temporary hardcoded match.found in hub.js cannot satisfy — it
        // tells every player they are white and facing 'Dev Opponent'.
        expect([eventA.color, eventB.color].sort()).toEqual(['black', 'white']);
        expect([eventA.opponent.username, eventB.opponent.username].sort())
            .toEqual(['QueueTestuser_a', 'QueueTestuser_b']);
        // Both sides' clocks start at the full time control (CW-61) — no longer
        // the hardcoded null from the CW-36 stub.
        expect(eventA.clocks).toEqual({ white: 600000, black: 600000 });
        expect(eventB.clocks).toEqual({ white: 600000, black: 600000 });
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


})

