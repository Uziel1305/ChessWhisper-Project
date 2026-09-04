const http = require('http');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const app = require('../src/app');
const pool = require('../src/db/pool');
const queue = require('../src/matchmaking/queue');
const { attachHub } = require('../src/ws/hub');



function accessTokenFor(userId) {
    return jwt.sign({ sub: String(userId) }, process.env.JWT_SECRET, {
        algorithm: 'HS256',
        expiresIn: '15m',
    });
}

let server;
let port;
const openClients = [];

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


function nextEvent(client, timeoutMs = 1000) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        client.once('message', (raw) => {
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
    const events = Promise.all([nextEvent(a), nextEvent(b)]);
    a.send(join);
    b.send(join);
    const [eventA] = await events;

    const white = eventA.color === 'white' ? a : b;
    const black = eventA.color === 'white' ? b : a;
    return { white, black, gameId: eventA.gameId };
}


function move(client, gameId, uci) {
    const event = nextEvent(client);
    client.send(JSON.stringify({ type: 'game.move', gameId, uci }));
    return event;
}

describe('game.move', () => {
    
    beforeAll(async () => {
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
        for (const client of openClients) {
            client.terminate();
        }
        await new Promise((resolve) => server.close(resolve));

        // moves cascades from games, so deleting the games takes the moves with
        // it. The games still have to go before the users, which do not cascade.
        await pool.query(`
            DELETE FROM games
             WHERE white_user_id IN (SELECT id FROM users WHERE username LIKE 'MovesTestuser_%')
                OR black_user_id IN (SELECT id FROM users WHERE username LIKE 'MovesTestuser_%')
        `);
        await pool.query("DELETE FROM users WHERE username LIKE 'MovesTestuser_%'");
        await pool.end();
    });

    it('accepts a legal move and returns the new position', async () => {
        const { white, gameId } = await matchedPair('MovesTestuser_legal');

        const event = await move(white, gameId, 'e2e4');

        expect(event.type).toBe('move.committed');
        expect(event.uci).toBe('e2e4');
        // Asserted in pieces rather than as one FEN string: the en passant field
        // is where chess.js versions differ, and pinning the whole thing would
        // make this fail on an upgrade that changed nothing that matters.
        expect(event.fen).toContain('4P3');
        expect(event.fen.split(' ')[1]).toBe('b');
    });

     // The three below all assert silence, and silence on its own proves nothing —
    // a server that never answered anything would pass. So each one follows up by
    // playing a legal first move: e2e4 only succeeds if the game never advanced.

    it('ignores an illegal move and leaves the position unchanged', async () => {
        const { white, gameId } = await matchedPair('MovesTestuser_illegal');

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
        expect(await move(outsider, gameId, 'e2e4')).toBeNull();

        const accepted = await move(white, gameId, 'e2e4');
        expect(accepted.type).toBe('move.committed');
    });


})