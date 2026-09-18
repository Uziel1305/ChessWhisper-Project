const { computeElo } = require('../src/rating/elo');

// elo.js is still empty (CW-132's job) — every one of these fails right now
// because computeElo is undefined. The numbers below are the standard Elo
// formula (expected = 1 / (1 + 10^((opponentRating - rating) / 400)),
// delta = round(K * (score - expected))) worked out by hand, so CW-132 has
// an exact target rather than "something Elo-shaped".
//
// gamesPlayedA/B is how many *already-finished* rated games that player has
// — i.e. what ratings.repo.js's countRatedGames (CW-133) will return before
// this game is counted. K=32 while that count is under 30 (this is at most
// their 30th rated game), K=16 from 30 onward.
describe('computeElo', () => {
    it('splits 16/-16 for a decisive result between equal ratings under 30 games', () => {
        const { deltaA, deltaB } = computeElo({
            ratingA: 1000,
            ratingB: 1000,
            score: 1, // A won
            gamesPlayedA: 0,
            gamesPlayedB: 0,
        });

        expect(deltaA).toBe(16);
        expect(deltaB).toBe(-16);
    });

    it('gives the upset winner a bigger swing than the equal-ratings case', () => {
        // 400 points apart — the underdog (A) winning is worth far more than
        // an equal-ratings win, and the favorite (B) losing costs far more
        // than a coin-flip loss would.
        const { deltaA, deltaB } = computeElo({
            ratingA: 800,
            ratingB: 1200,
            score: 1, // the 800-rated underdog won
            gamesPlayedA: 0,
            gamesPlayedB: 0,
        });

        expect(deltaA).toBe(29);
        expect(deltaB).toBe(-29);
        expect(deltaA).toBeGreaterThan(16);
    });

    it('gives the expected winner only a small swing when the favorite wins', () => {
        // Same 400-point gap as the upset case, but the other way round: A is
        // now the 1200-rated favorite and wins as expected. The swing should
        // be small in both directions — the opposite of the upset case above.
        const { deltaA, deltaB } = computeElo({
            ratingA: 1200,
            ratingB: 800,
            score: 1, // the 1200-rated favorite won, as expected
            gamesPlayedA: 0,
            gamesPlayedB: 0,
        });

        expect(deltaA).toBe(3);
        expect(deltaB).toBe(-3);
        expect(deltaA).toBeLessThan(16);
    });

    it('leaves equal ratings unchanged on a draw', () => {
        const { deltaA, deltaB } = computeElo({
            ratingA: 1000,
            ratingB: 1000,
            score: 0.5,
            gamesPlayedA: 0,
            gamesPlayedB: 0,
        });

        expect(deltaA).toBe(0);
        expect(deltaB).toBe(0);
    });

    // Locks in both sides of the K=32/K=16 boundary in one game: A is playing
    // their 30th rated game (still K=32), B their 31st (already K=16) — same
    // ratings, same result, but B's share of the swing is half of A's.
    it('uses K=32 under 30 games played and K=16 from 30 games onward, even within the same game', () => {
        const { deltaA, deltaB } = computeElo({
            ratingA: 1000,
            ratingB: 1000,
            score: 1, // A won
            gamesPlayedA: 29, // this is A's 30th rated game -> K=32
            gamesPlayedB: 30, // this is B's 31st rated game -> K=16
        });

        expect(deltaA).toBe(16);
        expect(deltaB).toBe(-8);
    });
});
