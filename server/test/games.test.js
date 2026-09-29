const crypto = require('crypto');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const pool = require('../src/db/pool');
const gamesRepo = require('../src/db/repositories/games.repo');
const ratingsRepo = require('../src/db/repositories/ratings.repo');
const usersRepo = require('../src/db/repositories/users.repo');

// Produces exactly what middleware/auth.js verifies: HS256 over a { sub } claim.
function accessTokenFor(userId) {
    return jwt.sign({ sub: String(userId) }, process.env.JWT_SECRET, {
        algorithm: 'HS256',
        expiresIn: '15m',
    });
}

function historyFor(userId) {
    return request(app)
        .get('/api/games/history')
        .set('Authorization', `Bearer ${accessTokenFor(userId)}`);
}

// Seeds a game straight through the repositories, the same writes GameManager
// makes, so these tests exercise the query without playing a real game.
// `endedAt` is pinned explicitly: finish() stamps now(), and games seeded in
// the same millisecond would make "newest first" untestable.
async function seedGame({ white, black, mode = 'classic', result, reason, endedAt, ratings = true }) {
    const id = crypto.randomUUID();
    await gamesRepo.insert({
        id, whiteUserId: white.id, blackUserId: black.id, mode, timeControlMs: 600000,
    });
    if (result) {
        await gamesRepo.finish({ id, result, reason });
        await pool.query('UPDATE games SET ended_at = $2 WHERE id = $1', [id, endedAt]);
        if (ratings) {
            const whiteDelta = result === '1-0' ? 10 : result === '0-1' ? -10 : 0;
            await ratingsRepo.recordRatingChange({
                gameId: id, userId: white.id, ratingBefore: 1000, ratingAfter: 1000 + whiteDelta,
            });
            await ratingsRepo.recordRatingChange({
                gameId: id, userId: black.id, ratingBefore: 1000, ratingAfter: 1000 - whiteDelta,
            });
        }
    }
    return id;
}

describe('GET /api/games/history', () => {
    let alice;
    let bob;
    let carol;
    let dave;
    let fresh;

    beforeAll(async () => {
        // The hash is never checked here — these users only ever authenticate
        // through accessTokenFor — so any string will do.
        alice = await usersRepo.insert('testhist_alice', 'not-a-real-hash');
        bob = await usersRepo.insert('testhist_bob', 'not-a-real-hash');
        carol = await usersRepo.insert('testhist_carol', 'not-a-real-hash');
        dave = await usersRepo.insert('testhist_dave', 'not-a-real-hash');
        fresh = await usersRepo.insert('testhist_fresh', 'not-a-real-hash');
    });

    afterAll(async () => {
        // games first: games -> users is RESTRICT, so the users could not go
        // while their games exist. rating_history (and moves, feedback) are
        // ON DELETE CASCADE from games, so they go with them.
        const ids = [alice, bob, carol, dave, fresh].map((u) => u.id);
        await pool.query(
            'DELETE FROM games WHERE white_user_id = ANY($1) OR black_user_id = ANY($1)',
            [ids]
        );
        await pool.query('DELETE FROM users WHERE id = ANY($1)', [ids]);
        await pool.end();
    });

    it('rejects a request with no Authorization header with 401', async () => {
        const res = await request(app).get('/api/games/history');

        expect(res.status).toBe(401);
    });

    // The "fresh start" acceptance test: nothing played, nothing listed.
    it('returns an empty history and a total of 0 for a new player', async () => {
        const res = await historyFor(fresh.id);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ total: 0, games: [] });
    });

    it("shows one game from both sides, with opposite outcomes", async () => {
        await seedGame({
            white: alice, black: bob, mode: 'eval',
            result: '1-0', reason: 'checkmate', endedAt: '2026-01-01T10:00:00Z',
        });

        const aliceRes = await historyFor(alice.id);
        const bobRes = await historyFor(bob.id);

        expect(aliceRes.body.games[0]).toMatchObject({
            mode: 'eval', timeControlMs: 600000, color: 'white',
            opponent: 'testhist_bob', outcome: 'win', reason: 'checkmate', ratingDelta: 10,
        });
        expect(bobRes.body.games[0]).toMatchObject({
            mode: 'eval', color: 'black',
            opponent: 'testhist_alice', outcome: 'loss', reason: 'checkmate', ratingDelta: -10,
        });
    });

    it('reports a draw as a draw for both players', async () => {
        await seedGame({
            white: alice, black: bob,
            result: '1/2-1/2', reason: 'stalemate', endedAt: '2026-01-02T10:00:00Z',
        });

        const aliceRes = await historyFor(alice.id);
        const bobRes = await historyFor(bob.id);

        expect(aliceRes.body.games[0]).toMatchObject({ outcome: 'draw', ratingDelta: 0 });
        expect(bobRes.body.games[0]).toMatchObject({ outcome: 'draw', ratingDelta: 0 });
    });

    it('lists games newest first, and a black win as a loss for white', async () => {
        await seedGame({
            white: alice, black: bob,
            result: '0-1', reason: 'resign', endedAt: '2026-01-03T10:00:00Z',
        });

        const res = await historyFor(alice.id);

        expect(res.body.games.map((g) => g.outcome)).toEqual(['loss', 'draw', 'win']);
        expect(res.body.total).toBe(3);
    });

    it('leaves out games still in progress, from both the list and the total', async () => {
        await seedGame({ white: alice, black: bob });

        const res = await historyFor(alice.id);

        expect(res.body.games).toHaveLength(3);
        expect(res.body.total).toBe(3);
    });

    it("never shows another player's games", async () => {
        await seedGame({
            white: carol, black: dave,
            result: '1-0', reason: 'timeout', endedAt: '2026-01-04T10:00:00Z',
        });

        const res = await historyFor(alice.id);

        expect(res.body.games.every((g) => g.opponent === 'testhist_bob')).toBe(true);
        expect(res.body.total).toBe(3);
    });

    // A finished game is history whether or not its rating row exists. The
    // LEFT JOIN keeps it in the list and the count reads games, not
    // rating_history, so the two can never disagree about it.
    it('still lists and counts a finished game with no rating_history row', async () => {
        await seedGame({
            white: dave, black: carol,
            result: '0-1', reason: 'abandoned', endedAt: '2026-01-05T10:00:00Z', ratings: false,
        });

        const res = await historyFor(carol.id);

        expect(res.body.total).toBe(2);
        expect(res.body.games[0]).toMatchObject({
            opponent: 'testhist_dave', outcome: 'win', reason: 'abandoned', ratingDelta: null,
        });
    });
});
