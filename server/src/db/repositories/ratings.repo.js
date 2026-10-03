const pool = require('../pool');

// How many rated games this player has already finished — every mode is
// rated (mode names assist features, not a rated/casual split), so this needs
// no mode filter. Games against the engine are the one unrated kind, so any
// game with an is_engine participant is left out; for a game between two
// humans that clause is always true, so their count is what it always was.
// Without it, engine games would quietly move a player's K-factor.
// GameManager (CW-134) reads this *before* the current game is recorded, so
// the count passed into elo.js's K-factor logic is "games played before this
// one", matching what elo.js's gamesPlayed parameter expects.
async function countRatedGames(userId) {
    const result = await pool.query(
        `SELECT COUNT(*) FROM games
          WHERE (white_user_id = $1 OR black_user_id = $1)
            AND result IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM users u
                             WHERE u.is_engine
                               AND u.id IN (white_user_id, black_user_id))`,
        [userId]
    );
    // pg returns COUNT(*) as a string (it's a bigint), so this needs an
    // explicit parse — elo.js compares it numerically against 30.
    return parseInt(result.rows[0].count, 10);
}

// One row per player per game — GameManager (CW-134) calls this once for
// each side after computing both deltas, the same way it calls
// usersRepo.updateRating once per side. `db` defaults to the shared pool;
// endGame passes a transaction's client instead.
async function recordRatingChange({ gameId, userId, ratingBefore, ratingAfter }, db = pool) {
    const result = await db.query(
        `INSERT INTO rating_history (game_id, user_id, rating_before, rating_after)
         VALUES ($1, $2, $3, $4)
         RETURNING id, game_id, user_id, rating_before, rating_after, created_at`,
        [gameId, userId, ratingBefore, ratingAfter]
    );
    return result.rows[0];
}

module.exports = { countRatedGames, recordRatingChange };
