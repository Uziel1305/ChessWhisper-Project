const request = require('supertest');
const app = require('../src/app');
const pool = require('../src/db/pool');
const gamesRepo = require('../src/db/repositories/games.repo');
const usersRepo = require('../src/db/repositories/users.repo');
const ratingsRepo = require('../src/db/repositories/ratings.repo');
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

// Polls for every effect of endGame's persistence Promise.all (GameManager.js),
// not just games.result: those five writes (games.finish, two updateRating,
// two recordRatingChange) are independent, concurrently-dispatched queries
// with no ordering guarantee among them, so games.result landing first proves
// nothing about the other four. Checking that each user's current rating
// matches their own rating_history.rating_after proves the update and the
// history insert for that player are mutually consistent — i.e. both have
// landed — without assuming anything about what the rating started at.
async function waitForGameEnd(gameId, { timeoutMs = 3000, intervalMs = 20 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const row = await gamesRepo.findById(gameId);
        if (row.result !== null) {
            const [whiteUser, blackUser, historyResult] = await Promise.all([
                usersRepo.findById(row.white_user_id),
                usersRepo.findById(row.black_user_id),
                pool.query(
                    'SELECT user_id, rating_after FROM rating_history WHERE game_id = $1',
                    [gameId]
                ),
            ]);
            const whiteHistory = historyResult.rows.find(
                (r) => String(r.user_id) === String(row.white_user_id)
            );
            const blackHistory = historyResult.rows.find(
                (r) => String(r.user_id) === String(row.black_user_id)
            );
            if (
                historyResult.rows.length === 2 &&
                whiteHistory && blackHistory &&
                whiteUser.rating === whiteHistory.rating_after &&
                blackUser.rating === blackHistory.rating_after
            ) {
                return row;
            }
        }
        if (Date.now() >= deadline) {
            throw new Error(`Timed out waiting for game ${gameId} to end`);
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
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

        // White is always the side whose clock starts first, so white's flag is
        // the one that falls here — black wins. Note this is createGame's own
        // internal white/black (it coin-flips colour assignment regardless of
        // the players array's order), not necessarily whichever of our two
        // registered users we happened to call "white" below — row.white_user_id
        // / row.black_user_id below is the ground truth for who that actually is.
        const row = await waitForGameEnd(game.id);
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

    // Regression for the abandon-on-disconnect race: applyMove holds its own
    // reference to `game` across its `await movesRepo.insert(...)` gap, and
    // removing a game from GameManager's internal map (endGame's `remove()`)
    // does not invalidate a reference a caller already holds. If the opponent's
    // disconnect/resign/timeout reaches `endGame` first during that gap,
    // applyMove still calls `endGame` again on the very same object once its
    // await resolves. A plain "call abandon() twice" test would not catch this:
    // the first call's `remove()` already deletes the game from the map, so a
    // second `abandon()` just fails its own lookup and returns null via
    // unrelated, pre-existing behavior. This test instead calls the exported
    // `endGame()` directly on the same object twice, which is the actual shape
    // of the race.
    it('endGame is idempotent: a second call on the same game object does not double-apply ratings or rating_history', async () => {
        const whiteUserId = await registerPlayer('GameManagerTestuser_white2');
        const blackUserId = await registerPlayer('GameManagerTestuser_black2');

        const game = await GameManager.createGame({
            mode: 'classic',
            timeControl: 600000,
            players: [{ userId: whiteUserId }, { userId: blackUserId }],
        });

        // Simulates whichever termination path wins the race (e.g. the
        // opponent's disconnect landing during applyMove's await gap) and
        // finishes first.
        const first = await GameManager.endGame(game, { result: '1-0', reason: 'abandoned' });
        expect(first).not.toBeNull();

        const row = await gamesRepo.findById(game.id);
        expect(row.result).toBe('1-0');
        expect(row.reason).toBe('abandoned');
        expect(GameManager.get(game.id)).toBeUndefined();

        // Equal starting ratings (1000), zero rated games each, decisive
        // result — same magnitude as the timeout test above, mirrored since
        // white wins here instead of losing.
        const whiteAfterFirst = await usersRepo.findById(row.white_user_id);
        const blackAfterFirst = await usersRepo.findById(row.black_user_id);
        expect(whiteAfterFirst.rating).toBe(1016);
        expect(blackAfterFirst.rating).toBe(984);

        const historyAfterFirst = (await pool.query(
            'SELECT user_id FROM rating_history WHERE game_id = $1',
            [game.id]
        )).rows;
        expect(historyAfterFirst).toHaveLength(2);

        // Simulates applyMove reaching its own endGame call on the same
        // `game` object after losing the race.
        const second = await GameManager.endGame(game, { result: '0-1', reason: 'checkmate' });
        expect(second).toBeNull();

        // Nothing changed from the first call: same result/reason, same
        // ratings (not double-applied), no extra rating_history rows.
        const rowAfter = await gamesRepo.findById(game.id);
        expect(rowAfter.result).toBe('1-0');
        expect(rowAfter.reason).toBe('abandoned');

        const whiteAfterSecond = await usersRepo.findById(row.white_user_id);
        const blackAfterSecond = await usersRepo.findById(row.black_user_id);
        expect(whiteAfterSecond.rating).toBe(1016);
        expect(blackAfterSecond.rating).toBe(984);

        const historyAfterSecond = (await pool.query(
            'SELECT user_id FROM rating_history WHERE game_id = $1',
            [game.id]
        )).rows;
        expect(historyAfterSecond).toHaveLength(2);
    });

    // Regression for onFlag's missing .catch(): unlike every other endGame
    // trigger (abandon, resign, applyMove's outcome check), onFlag used to call
    // endGame with no error handling at all, so a rejection there became an
    // unhandled promise rejection — which crashes the whole process by
    // default, taking every other in-progress game down with it. Forcing
    // usersRepo.findById to reject once reproduces that rejection inside
    // endGame's own read step, without needing to fake an actual DB outage.
    it('logs, rather than crashes the process on, a timeout whose endGame call fails', async () => {
        const whiteUserId = await registerPlayer('GameManagerTestuser_white3');
        const blackUserId = await registerPlayer('GameManagerTestuser_black3');

        const game = await GameManager.createGame({
            mode: 'classic',
            timeControl: 50,
            players: [{ userId: whiteUserId }, { userId: blackUserId }],
        });

        // Installed only after createGame resolves: createGame makes its own
        // usersRepo.findById calls (for match.found's opponent display), and a
        // mock set up beforehand would be consumed by those instead of by
        // endGame's later read step.
        const findByIdSpy = jest.spyOn(usersRepo, 'findById').mockRejectedValueOnce(new Error('boom'));
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        // No DB postcondition to poll for here — the forced rejection happens
        // before endGame's persistence step ever runs, so nothing gets
        // written. A short real wait past the clock's expiry is enough to let
        // the rejection surface and onFlag's catch handle it.
        await new Promise((resolve) => setTimeout(resolve, 200));

        expect(errorSpy).toHaveBeenCalledWith(
            'endGame failed for timeout on game', game.id, ':', expect.any(Error)
        );
        // The game still comes off the live map — remove() runs synchronously
        // before the read step that was made to fail.
        expect(GameManager.get(game.id)).toBeUndefined();

        findByIdSpy.mockRestore();
        errorSpy.mockRestore();
    });

    // endGame's five writes (games.finish, two updateRating, two
    // recordRatingChange) must land together or not at all. Forcing the first
    // rating_history insert to fail — it runs after finish and both rating
    // updates — must leave the database exactly as it was before the game
    // ended: no result, no rating change, no history row. Without a
    // transaction, the writes that did not fail commit on their own and leave
    // a finished game whose ratings disagree with its history.
    it('persists nothing when one of endGame\'s writes fails', async () => {
        const whiteUserId = await registerPlayer('GameManagerTestuser_white4');
        const blackUserId = await registerPlayer('GameManagerTestuser_black4');

        const game = await GameManager.createGame({
            mode: 'classic',
            timeControl: 600000,
            players: [{ userId: whiteUserId }, { userId: blackUserId }],
        });

        // The other writes run for real; the spies only keep hold of what they
        // return. The failing insert waits for them to settle before it
        // rejects. Without that wait the rejection surfaces while they are
        // still in flight on other connections, and the assertions below read
        // the database before those writes land — a pass for the wrong reason,
        // which is exactly what this test's first version did.
        const finishSpy = jest.spyOn(gamesRepo, 'finish');
        const updateSpy = jest.spyOn(usersRepo, 'updateRating');
        const recordSpy = jest
            .spyOn(ratingsRepo, 'recordRatingChange')
            .mockImplementationOnce(async () => {
                await Promise.allSettled(
                    [...finishSpy.mock.results, ...updateSpy.mock.results].map((r) => r.value)
                );
                throw new Error('rating_history insert failed');
            });

        try {
            // Called directly, so the rejection reaches the test rather than a
            // caller's .catch — nothing is logged, and the error gate stays quiet.
            await expect(
                GameManager.endGame(game, { result: '1-0', reason: 'resign' })
            ).rejects.toThrow('rating_history insert failed');

            // The failure really did come after the other writes had run, so
            // there was something to undo.
            expect(finishSpy).toHaveBeenCalledTimes(1);
            expect(updateSpy).toHaveBeenCalledTimes(2);
        } finally {
            finishSpy.mockRestore();
            updateSpy.mockRestore();
            recordSpy.mockRestore();
        }

        const row = await gamesRepo.findById(game.id);
        expect(row.result).toBeNull();
        expect(row.reason).toBeNull();

        // Both players are new, so both started at the default 1000.
        const white = await usersRepo.findById(whiteUserId);
        const black = await usersRepo.findById(blackUserId);
        expect(white.rating).toBe(1000);
        expect(black.rating).toBe(1000);

        const history = (await pool.query(
            'SELECT 1 FROM rating_history WHERE game_id = $1',
            [game.id]
        )).rows;
        expect(history).toHaveLength(0);
    });
});
