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
async function finish({ id, result, reason }) {
    const updated = await pool.query(
        `UPDATE games
            SET result = $2, reason = $3, ended_at = now()
          WHERE id = $1 AND result IS NULL
      RETURNING id, result, reason, ended_at`,
        [id, result, reason]
    );
    return updated.rows[0];
}

module.exports = { insert, findById, UnknownPlayerError, finish };