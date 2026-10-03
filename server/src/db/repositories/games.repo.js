const pool = require('../pool');

// Lets GameManager react to a player who no longer exists without knowing
// anything about Postgres error codes. Everything pg-specific stops at this file.
class UnknownPlayerError extends Error {}



// Takes an object rather than positional arguments, unlike users.repo.insert.
// whiteUserId and blackUserId are adjacent values of the same type, so a
// positional swap would compile, run, and silently give both players the wrong
// colour — the kind of bug that only shows up as "the board is backwards".
async function insert({ id, whiteUserId, blackUserId, mode, timeControlMs }) {
    try {
        // Generate the id in Node so GameManager knows the game's identity before
        // inserting it. PostgreSQL does not need to generate and return the id.
        // We still await the INSERT before announcing the match, so database errors
        // are handled before the players are told the game exists.
        const result = await pool.query(
            `INSERT INTO games (id, white_user_id, black_user_id, mode, time_control_ms)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, white_user_id, black_user_id, mode, time_control_ms, started_at`,
            [id, whiteUserId, blackUserId, mode, timeControlMs]
        );
        return result.rows[0];
    } catch (err) {
        // 23503 is Postgres' foreign_key_violation. The upgrade deliberately
        // does not check that the token's user still exists, so this constraint
        // is the thing that actually enforces it — at the only moment it matters.
        if (err.code === '23503') {
            throw new UnknownPlayerError(`no such player (${err.constraint}): white=${whiteUserId} black=${blackUserId}`);
        }
        // Anything else is unexpected; let it surface rather than masking it.
        throw err;
    }
}

async function findById(id) {
    // $1 is a bound parameter, not string interpolation — the value can never
    // be parsed as SQL, so this is injection-safe by construction.
    const result = await pool.query(
        `SELECT id, white_user_id, black_user_id, mode, time_control_ms,
                result, reason, started_at, ended_at
        FROM games WHERE id=$1`,
        [id]
    );
    // undefined when there is no match, which reads naturally at the call site.
    return result.rows[0];
}

// Writes the result of a finished game. The WHERE clause is doing real work:
// `result IS NULL` means only a game still in progress can be ended, so a second
// call — a resignation racing a checkmate, a timeout arriving after a mate —
// updates nothing rather than overwriting the real outcome with a later one.
// An undefined return is how the caller learns the game was already over.
//
// `db` defaults to the shared pool. endGame passes a transaction's client
// instead, so this write commits or rolls back together with the rating writes.
async function finish({ id, result, reason }, db = pool) {
    const updated = await db.query(
        `UPDATE games
            SET result = $2, reason = $3, ended_at = now()
          WHERE id = $1 AND result IS NULL
      RETURNING id, result, reason, ended_at`,
        [id, result, reason]
    );
    return updated.rows[0];
}

// A player's finished games, newest first, each seen from that player's side:
// which colour they had, who the opponent was, and their own rating change.
// `g.id` breaks ties between games that ended at the same instant, so the order
// is stable between requests and across the LIMIT cutoff.
//
// The opponent is an inner JOIN because games -> users is RESTRICT: a user who
// has games cannot be deleted, so the opponent always exists. rating_history is
// a LEFT JOIN so a finished game still appears even if its rating row is missing
// — rating_before/after then come back null.
async function findHistoryByUser(userId, limit) {
    const result = await pool.query(
        `SELECT g.id, g.mode, g.time_control_ms, g.result, g.reason, g.ended_at,
                CASE WHEN g.white_user_id = $1 THEN 'white' ELSE 'black' END AS color,
                opp.username AS opponent_username,
                rh.rating_before, rh.rating_after
           FROM games g
           JOIN users opp ON opp.id = CASE WHEN g.white_user_id = $1
                                           THEN g.black_user_id ELSE g.white_user_id END
           LEFT JOIN rating_history rh ON rh.game_id = g.id AND rh.user_id = $1
          WHERE (g.white_user_id = $1 OR g.black_user_id = $1) AND g.result IS NOT NULL
          ORDER BY g.ended_at DESC, g.id DESC
          LIMIT $2`,
        [userId, limit]
    );
    return result.rows;
}

// The home screen's Games counter: every finished game, either colour —
// engine games included, since history lists them too. Deliberately separate
// from ratingsRepo.countRatedGames, which answers "rated games" for Elo's
// K-factor and leaves engine games out. The two agree for every human-vs-human
// game and differ only by a player's engine games.
async function countFinishedByUser(userId) {
    const result = await pool.query(
        `SELECT COUNT(*) FROM games
          WHERE (white_user_id = $1 OR black_user_id = $1)
            AND result IS NOT NULL`,
        [userId]
    );
    // COUNT(*) is a bigint, which pg returns as a string.
    return parseInt(result.rows[0].count, 10);
}

module.exports = { insert, findById, UnknownPlayerError, finish, findHistoryByUser, countFinishedByUser };