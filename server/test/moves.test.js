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

// Collects the next `count` events, or whatever arrived before the timeout. A
// move that ends the game sends two — move.committed, then game.end — so a
// single-shot listener would silently miss the second.
function nextEvents(client, count, timeoutMs = 1000) {
    const events = [];
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(events), timeoutMs);
        const onMessage = (raw) => {
            events.push(JSON.parse(raw));
            if (events.length === count) {
                clearTimeout(timer);
                client.off('message', onMessage);
                resolve(events);
            }
        };
        client.on('message', onMessage);
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

     // CW-52. moves.test.js otherwise only ever listens on the mover's socket,
    // so nothing proves the opponent gets their copy — which is the whole point
    // of the story. The broadcast already exists in applyMove, so this passes
    // immediately rather than going red first.
    it('delivers the move to the opponent as well as the mover', async () => {
        const { white, black, gameId } = await matchedPair('MovesTestuser_broadcast');

        // Both listeners attach before the send, or the opponent's copy can
        // arrive before anything is listening for it.
        const events = Promise.all([nextEvent(white), nextEvent(black)]);
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
        await move(white, gameId, 'f2f3');
        await move(black, gameId, 'e7e5');
        await move(white, gameId, 'g2g4');

        // Black delivers the mate, so white is the one to watch: they receive
        // the move and then the ending, in that order.
        const events = nextEvents(white, 2);
        await move(black, gameId, 'd8h4');
        const [committed, ended] = await events;

        expect(committed.type).toBe('move.committed');
        expect(ended.type).toBe('game.end');
        // Black mated, so black wins. PGN notation, matching games.result's CHECK.
        expect(ended.result).toBe('0-1');
        expect(ended.reason).toBe('checkmate');
    });

    it('ends the game when a player resigns', async () => {
        const { white, black, gameId } = await matchedPair('MovesTestuser_resign');

        // No move.committed here — resignation is not a move, so the opponent
        // receives game.end on its own.
        const ended = nextEvent(black);
        white.send(JSON.stringify({ type: 'game.resign', gameId }));

        const event = await ended;
        expect(event.type).toBe('game.end');
        // The resigner loses, so white resigning is a win for black.
        expect(event.result).toBe('0-1');
        expect(event.reason).toBe('resign');
    });

    it('ends the game as a loss for whoever disconnects mid-game', async () => {
        const { white, black, gameId } = await matchedPair('MovesTestuser_abandon');

        // terminate(), not close(): this stands in for a crash/force-stop/lost
        // network, not a graceful leave — the abrupt case the disconnect
        // handler exists for. Either way the server sees a 'close' event.
        const ended = nextEvent(black);
        white.terminate();

        const event = await ended;
        expect(event.type).toBe('game.end');
        // Whoever disconnected loses, so white dropping is a win for black.
        expect(event.result).toBe('0-1');
        expect(event.reason).toBe('abandoned');
    });

})