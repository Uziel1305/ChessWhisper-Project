const crypto = require('crypto');
const pool = require('../src/db/pool');
const gamesRepo = require('../src/db/repositories/games.repo');
const ratingsRepo = require('../src/db/repositories/ratings.repo');
const usersRepo = require('../src/db/repositories/users.repo');

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

describe('ratingsRepo.countRatedGames', () => {
    let alice;
    let bob;
    let carol;

    beforeAll(async () => {
        await deleteTestUsers();
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

    afterAll(async () => {
        await deleteTestUsers();
        await pool.end();
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
