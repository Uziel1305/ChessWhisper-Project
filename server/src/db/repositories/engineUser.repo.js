const pool = require('../pool');

// The system user the engine plays as (007_engine_user.sql). Kept out of
// users.repo.js so the human-account queries stay exactly as they were.
// undefined when the row is missing — the migration skips it if a human already
// holds the name — which the caller reports as the engine being unavailable.
async function findEngineUser() {
    const result = await pool.query(
        'SELECT id, username, rating FROM users WHERE is_engine'
    );
    return result.rows[0];
}

module.exports = { findEngineUser };
