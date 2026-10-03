const crypto = require('crypto');
const pool = require('../src/db/pool');
const gamesRepo = require('../src/db/repositories/games.repo');
const ratingsRepo = require('../src/db/repositories/ratings.repo');
const usersRepo = require('../src/db/repositories/users.repo');
const engineUserRepo = require('../src/db/repositories/engineUser.repo');
const GameManager = require('../src/game/GameManager');

// countRatedGames is what elo.js's K-factor reads (gamesPlayed < 30 → K=32), so
// a change to what it counts silently changes every rating swing. Until now it
// had no test of its own — gameManager.test.js only ever sees it through brand
// new players with zero games. These pin what it counts for human games.

// Seeds a game straight through the repositories, as games.test.js does.
async function seedGame({ white, black, result = null }) {
    const id = crypto.randomUUID();
    await gamesRepo.insert({
        id, whiteUserId: white.id, blackUserId: black.id, mode: 'classic', timeControlMs: 600000,
    });
    if (result) await gamesRepo.finish({ id, result, reason: 'checkmate' });
    return id;
}

async function deleteTestUsers() {
    await pool.query(`
        DELETE FROM games
         WHERE white_user_id IN (SELECT id FROM users WHERE username LIKE 'RatingsTestuser_%')
            OR black_user_id IN (SELECT id FROM users WHERE username LIKE 'RatingsTestuser_%')
    `);
    await pool.query("DELETE FROM users WHERE username LIKE 'RatingsTestuser_%'");
}

beforeAll(deleteTestUsers);

afterAll(async () => {
    await deleteTestUsers();
    await pool.end();
});

describe('ratingsRepo.countRatedGames', () => {
    let alice;
    let bob;
    let carol;

    beforeAll(async () => {
        // The hash is never checked: these users never log in.
        alice = await usersRepo.insert('RatingsTestuser_alice', 'not-a-real-hash');
        bob = await usersRepo.insert('RatingsTestuser_bob', 'not-a-real-hash');
        carol = await usersRepo.insert('RatingsTestuser_carol', 'not-a-real-hash');

        // alice: two finished as white, one finished as black, one in progress.
        await seedGame({ white: alice, black: bob, result: '1-0' });
        await seedGame({ white: alice, black: bob, result: '1/2-1/2' });
        await seedGame({ white: bob, black: alice, result: '0-1' });
        await seedGame({ white: alice, black: bob });
        // A game alice is not in.
        await seedGame({ white: bob, black: carol, result: '1-0' });
    });

    it('counts finished games of either colour, and nothing still in progress', async () => {
        expect(await ratingsRepo.countRatedGames(alice.id)).toBe(3);
    });

    it("never counts another player's games", async () => {
        expect(await ratingsRepo.countRatedGames(carol.id)).toBe(1);
        expect(await ratingsRepo.countRatedGames(bob.id)).toBe(4);
    });

    it('is 0 for a player with no finished games', async () => {
        const fresh = await usersRepo.insert('RatingsTestuser_fresh', 'not-a-real-hash');
        expect(await ratingsRepo.countRatedGames(fresh.id)).toBe(0);
    });

    // Every game between two humans is rated, so the K-factor count and the
    // Games counter agree for them. They are allowed to differ only for a game
    // that is not rated.
    it('agrees with the Games counter for human-vs-human games', async () => {
        for (const user of [alice, bob, carol]) {
            expect(await ratingsRepo.countRatedGames(user.id))
                .toBe(await gamesRepo.countFinishedByUser(user.id));
        }
    });
});

// Engine games are unrated. They must not count toward the K-factor, or 30 of
// them would halve a player's rating swings in human games. They still count
// for the Games counter, which means "finished games".
describe('engine games and the rated-game count', () => {
    let engine;
    let player;

    beforeAll(async () => {
        engine = await engineUserRepo.findEngineUser();
        player = await usersRepo.insert('RatingsTestuser_vsengine', 'not-a-real-hash');
        // 30 finished engine games, 15 as each colour: past elo.js's 30-game
        // threshold if they were counted.
        for (let i = 0; i < 30; i++) {
            const asWhite = i % 2 === 0;
            await seedGame({
                white: asWhite ? player : engine,
                black: asWhite ? engine : player,
                result: '1-0',
            });
        }
    });

    it('leaves engine games out of countRatedGames but not out of the Games counter', async () => {
        expect(await ratingsRepo.countRatedGames(player.id)).toBe(0);
        expect(await gamesRepo.countFinishedByUser(player.id)).toBe(30);
    });

    // End to end through the real endGame: equal ratings and a decisive result
    // give ±16 at K=32. Had the 30 engine games counted, this player would be
    // on K=16 and move by 8.
    it('keeps the player on K=32 for their next human game', async () => {
        const opponent = await usersRepo.insert('RatingsTestuser_human', 'not-a-real-hash');
        const game = await GameManager.createGame({
            mode: 'classic',
            timeControl: 600000,
            players: [{ userId: player.id }, { userId: opponent.id }],
        });
        const playerIsWhite = String(game.whiteUserId) === String(player.id);
        // The player wins, whichever colour the coin flip gave them.
        await GameManager.endGame(game, { result: playerIsWhite ? '1-0' : '0-1', reason: 'resign' });

        expect((await usersRepo.findById(player.id)).rating).toBe(1016);
        expect((await usersRepo.findById(opponent.id)).rating).toBe(984);
    });
});
