const request = require('supertest');
const app = require('../src/app');
const pool = require('../src/db/pool');
const gamesRepo = require('../src/db/repositories/games.repo');
const GameManager = require('../src/game/GameManager');

// Exercises GameManager.createGame directly rather than through queue.join: the
// real matchmaking path can only ever ask for 180000/300000/600000 (queue.js's
// TIME_CONTROLS), and there is no way to wait out even the shortest of those in a
// test. createGame itself never validates timeControl, so a short one here is a
// direct, valid call — just not one a real client could ever make.
async function registerPlayer(username) {
    const res = await request(app)
        .post('/api/auth/register')
        .send({ username, password: 'a-strong-password-123' });
    expect(res.status).toBe(201);
    return res.body.userId;
}

describe('GameManager — clock flag integration', () => {
    afterAll(async () => {
        await pool.query(`
            DELETE FROM games
             WHERE white_user_id IN (SELECT id FROM users WHERE username LIKE 'GameManagerTestuser_%')
                OR black_user_id IN (SELECT id FROM users WHERE username LIKE 'GameManagerTestuser_%')
        `);
        await pool.query("DELETE FROM users WHERE username LIKE 'GameManagerTestuser_%'");
        await pool.end();
    });

    it('ends the game by timeout when a clock reaches zero, with the correct winner', async () => {
        const whiteUserId = await registerPlayer('GameManagerTestuser_white');
        const blackUserId = await registerPlayer('GameManagerTestuser_black');

        const game = await GameManager.createGame({
            mode: 'classic',
            timeControl: 50,
            players: [{ userId: whiteUserId }, { userId: blackUserId }],
        });

        // Real wait, not fake timers — createGame/endGame make real async DB
        // calls (gamesRepo.insert, gamesRepo.finish, usersRepo.findById), and
        // mixing those with jest.useFakeTimers() is a known source of flaky
        // fake-timer/promise-ordering interaction. 150ms is negligible next to
        // the real Postgres round trips every other test here already makes.
        await new Promise((resolve) => setTimeout(resolve, 150));

        // White is always the side whose clock starts first, so white's flag is
        // the one that falls here — black wins.
        const row = await gamesRepo.findById(game.id);
        expect(row.result).toBe('0-1');
        expect(row.reason).toBe('timeout');

        // endGame's remove() ran — the game is no longer live.
        expect(GameManager.get(game.id)).toBeUndefined();
    });
});
