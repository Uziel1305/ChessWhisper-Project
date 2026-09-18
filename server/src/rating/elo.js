// Standard Elo, computed independently for each side rather than mirroring
// one delta — the two players can be on different K-factors in the same
// game (see kFor below), so their rating changes are not simply +/- of each
// other except by coincidence.

// A rated player is still "provisional" for their first 30 rated games —
// bigger swings while the system is still learning their strength, smaller
// ones once it has enough games to trust. gamesPlayed is how many rated
// games this player had *before* this one (ratings.repo.js's
// countRatedGames), so a value of 29 here means this is their 30th — still
// under the threshold — and 30 means their 31st, the first game at K=16.
function kFor(gamesPlayed) {
    return gamesPlayed < 30 ? 32 : 16;
}

// The probability this side was expected to score, per the logistic curve
// Elo is built on. Symmetric: expectedFor(ratingB, ratingA) is exactly
// 1 - expectedFor(ratingA, ratingB), so the two sides' expectations always
// sum to 1 without needing to compute it twice.
function expectedFor(rating, opponentRating) {
    return 1 / (1 + Math.pow(10, (opponentRating - rating) / 400));
}

// score is A's result: 1 for a win, 0 for a loss, 0.5 for a draw. Rounded to
// the nearest integer rather than truncated, so a game worth "half a point"
// of rating doesn't just vanish.
function computeElo({ ratingA, ratingB, score, gamesPlayedA, gamesPlayedB }) {
    const expectedA = expectedFor(ratingA, ratingB);
    const expectedB = 1 - expectedA;
    const scoreB = 1 - score;

    const deltaA = Math.round(kFor(gamesPlayedA) * (score - expectedA));
    const deltaB = Math.round(kFor(gamesPlayedB) * (scoreB - expectedB));

    return { deltaA, deltaB };
}

module.exports = { computeElo };
