const http = require('http');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const app = require('../src/app');
const pool = require('../src/db/pool');
const queue = require('../src/matchmaking/queue');
const { attachHub, closeHub } = require('../src/ws/hub');
const gamesRepo = require('../src/db/repositories/games.repo');
const usersRepo = require('../src/db/repositories/users.repo');
const GameManager = require('../src/game/GameManager');
const engineOpponent = require('../src/game/engineOpponent');
const { expectServerError } = require('./helpers/serverErrors');

// The engine is mocked: each test scripts what chooseMove answers. Everything
// else — hub, GameManager, clocks, database — is real.
jest.mock('../src/engine/engineClient');
const engineClient = require('../src/engine/engineClient');

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

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

// chooseMove answers from this list in order. An entry is a UCI string, or an
// Error to reject with. Running out is a test bug, reported as a rejection.
function scriptEngine(answers) {
    const remaining = [...answers];
    engineClient.chooseMove.mockImplementation(async () => {
        if (remaining.length === 0) throw new Error('engine script exhausted');
        const next = remaining.shift();
        if (next instanceof Error) throw next;
        return { bestMove: next };
    });
}

// A registered, connected player who has started an engine game. humanColor is
// forced by pinning the coin flip in createEngineGame.
async function startEngineGame(name, humanColor) {
    const id = await registerPlayer(`EngineGameTestuser_${name}`);
    const client = await connect(accessTokenFor(id));

    const random = jest.spyOn(Math, 'random').mockReturnValue(humanColor === 'white' ? 0.1 : 0.9);
    const found = take(client);
    client.send(JSON.stringify({ type: 'engine.start', mode: 'classic', timeControl: 600000 }));
    const matchFound = await found;
    random.mockRestore();

    expect(matchFound).toMatchObject({ type: 'match.found', color: humanColor });
    activeGames.push({ gameId: matchFound.gameId, userId: id });
    return { id, client, gameId: matchFound.gameId, matchFound };
}

function send(client, event) {
    client.send(JSON.stringify(event));
}

async function ratingHistoryRows(gameId) {
    return (await pool.query('SELECT 1 FROM rating_history WHERE game_id = $1', [gameId])).rows;
}

// For endings the human does not see happen synchronously (disconnect).
async function waitForResult(gameId, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const row = await gamesRepo.findById(gameId);
        if (row.result !== null) return row;
        if (Date.now() >= deadline) throw new Error(`game ${gameId} never ended`);
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

async function deleteTestUsers() {
    await pool.query(`
        DELETE FROM games
         WHERE white_user_id IN (SELECT id FROM users WHERE username LIKE 'EngineGameTestuser_%')
            OR black_user_id IN (SELECT id FROM users WHERE username LIKE 'EngineGameTestuser_%')
    `);
    await pool.query("DELETE FROM users WHERE username LIKE 'EngineGameTestuser_%'");
}

describe('games against the engine', () => {
    beforeAll(async () => {
        await deleteTestUsers();
        server = http.createServer(app);
        attachHub(server);
        await new Promise((resolve) => server.listen(0, resolve));
        port = server.address().port;
        // Short enough to wait out; the real values are 15s and 2s.
        engineOpponent._setTiming({ deadlineMs: 400, retryIntervalMs: 50 });
    });

    beforeEach(() => {
        queue.clear();
        engineClient.chooseMove.mockReset();
        engineClient.evaluate.mockReset();
    });

    afterAll(async () => {
        for (const { gameId, userId } of activeGames) {
            if (GameManager.get(gameId)) await GameManager.resign({ gameId, userId });
        }
        await closeHub();
        for (const client of openClients) client.terminate();
        await new Promise((resolve) => server.close(resolve));
        await deleteTestUsers();
        await pool.end();
    });

    it('starts at once with match.found naming the engine, and the engine waits for White', async () => {
        const { matchFound } = await startEngineGame('start', 'white');

        expect(matchFound).toEqual({
            type: 'match.found',
            gameId: expect.any(String),
            color: 'white',
            mode: 'classic',
            opponent: { username: 'ChessWhisper Engine', rating: 1000 },
            fen: START_FEN,
            legalMoves: expect.arrayContaining(['e2e4', 'g1f3']),
            timeControlMs: 600000,
            clocks: { white: expect.any(Number), black: 600000 },
        });
        expect(engineClient.chooseMove).not.toHaveBeenCalled();

        const row = await gamesRepo.findById(matchFound.gameId);
        expect(row).toMatchObject({ mode: 'classic', time_control_ms: 600000, result: null });
    });

    it('lets the engine move first when it has White', async () => {
        scriptEngine(['e2e4']);
        const { client, gameId } = await startEngineGame('enginewhite', 'black');

        const committed = await take(client);
        expect(committed).toMatchObject({ type: 'move.committed', uci: 'e2e4' });
        expect(committed.fen.split(' ')[1]).toBe('b');
        expect(committed.legalMoves).toContain('e7e5');
        expect(engineClient.chooseMove).toHaveBeenCalledWith(START_FEN, 400);

        const moves = (await pool.query('SELECT ply, uci FROM moves WHERE game_id = $1', [gameId])).rows;
        expect(moves).toEqual([{ ply: 1, uci: 'e2e4' }]);
    });

    it("answers the player's move through the same commit path", async () => {
        scriptEngine(['e7e5']);
        const { client, gameId } = await startEngineGame('reply', 'white');

        send(client, { type: 'game.move', gameId, uci: 'e2e4' });
        expect(await take(client)).toMatchObject({ type: 'move.committed', uci: 'e2e4' });
        expect(await take(client)).toMatchObject({ type: 'move.committed', uci: 'e7e5' });

        const moves = (await pool.query(
            'SELECT ply, uci FROM moves WHERE game_id = $1 ORDER BY ply', [gameId]
        )).rows;
        expect(moves).toEqual([{ ply: 1, uci: 'e2e4' }, { ply: 2, uci: 'e7e5' }]);
    });

    it('ends on checkmate with no rating fields, no rating_history and no rating change', async () => {
        // Fool's mate, the player as Black delivering it.
        scriptEngine(['f2f3', 'g2g4']);
        const { id, client, gameId } = await startEngineGame('mate', 'black');

        expect(await take(client)).toMatchObject({ uci: 'f2f3' });
        send(client, { type: 'game.move', gameId, uci: 'e7e5' });
        expect(await take(client)).toMatchObject({ uci: 'e7e5' });
        expect(await take(client)).toMatchObject({ uci: 'g2g4' });
        send(client, { type: 'game.move', gameId, uci: 'd8h4' });
        expect(await take(client)).toMatchObject({ type: 'move.committed', uci: 'd8h4' });

        // Exact: newRating and ratingDelta are absent, not null.
        expect(await take(client)).toEqual({ type: 'game.end', result: '0-1', reason: 'checkmate' });

        expect(await gamesRepo.findById(gameId)).toMatchObject({ result: '0-1', reason: 'checkmate' });
        expect(await ratingHistoryRows(gameId)).toHaveLength(0);
        expect((await usersRepo.findById(id)).rating).toBe(1000);
        const engine = (await pool.query('SELECT rating FROM users WHERE is_engine')).rows[0];
        expect(engine.rating).toBe(1000);
        expect(GameManager.get(gameId)).toBeUndefined();
    });

    it('ends on resignation, unrated', async () => {
        const { id, client, gameId } = await startEngineGame('resign', 'white');

        send(client, { type: 'game.resign', gameId });
        expect(await take(client)).toEqual({ type: 'game.end', result: '0-1', reason: 'resign' });
        expect(await ratingHistoryRows(gameId)).toHaveLength(0);
        expect((await usersRepo.findById(id)).rating).toBe(1000);
    });

    it('ends as abandoned when the player disconnects, unrated', async () => {
        const { id, client, gameId } = await startEngineGame('abandon', 'white');

        client.terminate();
        const row = await waitForResult(gameId);
        expect(row).toMatchObject({ result: '0-1', reason: 'abandoned' });
        expect(await ratingHistoryRows(gameId)).toHaveLength(0);
        expect((await usersRepo.findById(id)).rating).toBe(1000);
    });

    it('lists the finished game in history with no rating delta, and counts it', async () => {
        const { id, client, gameId } = await startEngineGame('history', 'white');
        send(client, { type: 'game.resign', gameId });
        expect(await take(client)).toMatchObject({ type: 'game.end' });

        const res = await request(app)
            .get('/api/games/history')
            .set('Authorization', `Bearer ${accessTokenFor(id)}`);
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(1);
        expect(res.body.games).toEqual([expect.objectContaining({
            id: gameId,
            mode: 'classic',
            color: 'white',
            opponent: 'ChessWhisper Engine',
            outcome: 'loss',
            reason: 'resign',
            ratingDelta: null,
        })]);
    });

    it('refuses an illegal move from the engine, then commits its next answer', async () => {
        scriptEngine(['e7e4', 'e7e5']);
        const { client, gameId } = await startEngineGame('illegal', 'white');

        expectServerError(/^game\.move illegal: e7e4/);
        send(client, { type: 'game.move', gameId, uci: 'e2e4' });
        expect(await take(client)).toMatchObject({ uci: 'e2e4' });
        expect(await take(client)).toMatchObject({ type: 'move.committed', uci: 'e7e5' });
    });

    it('recovers when the engine fails once and then answers: the game goes on', async () => {
        scriptEngine([new Error('engine down'), 'e7e5', 'g8f6']);
        const { client, gameId } = await startEngineGame('recover', 'white');

        expectServerError(/^engine move failed for game .* engine down/);
        send(client, { type: 'game.move', gameId, uci: 'e2e4' });
        expect(await take(client)).toMatchObject({ uci: 'e2e4' });
        expect(await take(client)).toMatchObject({ type: 'move.committed', uci: 'e7e5' });

        // Still a live game: the player moves again and the engine answers.
        send(client, { type: 'game.move', gameId, uci: 'g1f3' });
        expect(await take(client)).toMatchObject({ uci: 'g1f3' });
        expect(await take(client)).toMatchObject({ type: 'move.committed', uci: 'g8f6' });

        // No game.end was sent — past the forfeit deadline, nothing more arrives.
        expect(await take(client, 600)).toBeNull();
        expect(GameManager.get(gameId)).toBeDefined();
        expect((await gamesRepo.findById(gameId)).result).toBeNull();
    });

    it('forfeits when the engine keeps failing past the deadline: the player wins', async () => {
        engineClient.chooseMove.mockRejectedValue(new Error('engine down'));
        const { id, client, gameId } = await startEngineGame('forfeit', 'white');

        expectServerError(/^engine move failed for game .* engine down/);
        send(client, { type: 'game.move', gameId, uci: 'e2e4' });
        expect(await take(client)).toMatchObject({ uci: 'e2e4' });
        expect(await take(client, 2000)).toEqual({
            type: 'game.end', result: '1-0', reason: 'engine_failed',
        });

        expect(engineClient.chooseMove.mock.calls.length).toBeGreaterThan(1); // it did retry
        expect(await gamesRepo.findById(gameId)).toMatchObject({ result: '1-0', reason: 'engine_failed' });
        expect(await ratingHistoryRows(gameId)).toHaveLength(0);
        expect((await usersRepo.findById(id)).rating).toBe(1000);
    });

    it('allows one engine game at a time per player', async () => {
        const { client } = await startEngineGame('twice', 'white');

        send(client, { type: 'engine.start', mode: 'classic', timeControl: 600000 });
        expect(await take(client)).toMatchObject({ type: 'queue.rejected', error: 'already_playing' });
    });

    it('rejects a mode not offered against the engine, an unknown mode, and an unknown time control', async () => {
        const id = await registerPlayer('EngineGameTestuser_badstart');
        const client = await connect(accessTokenFor(id));

        send(client, { type: 'engine.start', mode: 'eval', timeControl: 600000 });
        expect(await take(client)).toMatchObject({ type: 'queue.rejected', error: 'mode_not_offered' });
        send(client, { type: 'engine.start', mode: 'blitz', timeControl: 600000 });
        expect(await take(client)).toMatchObject({ type: 'queue.rejected', error: 'unknown_mode' });
        send(client, { type: 'engine.start', mode: 'classic', timeControl: 12345 });
        expect(await take(client)).toMatchObject({ type: 'queue.rejected', error: 'unknown_time_control' });
    });

    // The hub calls afterHumanMove after every committed move. For a game
    // between two humans it must do nothing at all.
    it('does nothing for a human-vs-human game', async () => {
        const a = await registerPlayer('EngineGameTestuser_human_a');
        const b = await registerPlayer('EngineGameTestuser_human_b');
        const game = await GameManager.createGame({
            mode: 'classic', timeControl: 600000, players: [{ userId: a }, { userId: b }],
        });
        activeGames.push({ gameId: game.id, userId: a });

        expect(game.unrated).toBeUndefined();
        expect(engineOpponent.afterHumanMove(game.id)).toBeUndefined();
        expect(engineClient.chooseMove).not.toHaveBeenCalled();
    });
});
