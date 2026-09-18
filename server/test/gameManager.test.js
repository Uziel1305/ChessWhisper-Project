const request = require('supertest');
const app = require('../src/app');
const pool = require('../src/db/pool');
const gamesRepo = require('../src/db/repositories/games.repo');
const usersRepo = require('../src/db/repositories/users.repo');
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
        // the one that falls here — black wins. Note this is createGame's own
        // internal white/black (it coin-flips colour assignment regardless of
        // the players array's order), not necessarily whichever of our two
        // registered users we happened to call "white" below — row.white_user_id
        // / row.black_user_id below is the ground truth for who that actually is.
        const row = await gamesRepo.findById(game.id);
        expect(row.result).toBe('0-1');
        expect(row.reason).toBe('timeout');

        // endGame's remove() ran — the game is no longer live.
        expect(GameManager.get(game.id)).toBeUndefined();

        // CW-134: endGame now applies ratings too. Both players are brand new
        // (default 1000, zero rated games each), so this is the same
        // equal-ratings, decisive-result case elo.test.js locks in as ±16 —
        // whoever createGame actually assigned white loses (per row.result
        // above), whoever it assigned black gains. Read the ratings via
        // row.white_user_id/row.black_user_id, not our local whiteUserId/
        // blackUserId variables — those name which user we registered first,
        // not which colour createGame's coin flip gave them.
        const actualWhite = await usersRepo.findById(row.white_user_id);
        const actualBlack = await usersRepo.findById(row.black_user_id);
        expect(actualWhite.rating).toBe(984);
        expect(actualBlack.rating).toBe(1016);

        const historyRows = (await pool.query(
            'SELECT user_id, rating_before, rating_after FROM rating_history WHERE game_id = $1',
            [game.id]
        )).rows;
        expect(historyRows).toHaveLength(2);

        const whiteHistory = historyRows.find((r) => String(r.user_id) === String(row.white_user_id));
        const blackHistory = historyRows.find((r) => String(r.user_id) === String(row.black_user_id));
        expect(whiteHistory).toMatchObject({ rating_before: 1000, rating_after: 984 });
        expect(blackHistory).toMatchObject({ rating_before: 1000, rating_after: 1016 });
    });
});
