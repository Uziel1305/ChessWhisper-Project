const pool = require('../pool');

// Records one move's private verdict. Only ever called for a classified ply —
// classifyPly (GameManager) already holds evalBefore, evalAfter and the mover's
// user id by the time this is reached, so there is nothing to look up here. No
// duplicate check before inserting: 004_feedback.sql's UNIQUE (game_id, ply) is
// what actually decides that, the same principle moves.repo.js follows.
async function insert({ gameId, ply, ownerUserId, classification, cpLoss }) {
    const result = await pool.query(
        `INSERT INTO feedback (game_id, ply, owner_user_id, classification, cp_loss)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, game_id, ply, owner_user_id, classification, cp_loss, created_at`,
        [gameId, ply, ownerUserId, classification, cpLoss]
    );
    return result.rows[0];
}

// Owner-scoped by construction: ownerUserId is a required argument, not an
// optional filter, so there is no call shape that can return both players'
// rows for a game. Feedback is private — see the table's own comment.
async function findByGame({ gameId, ownerUserId }) {
    const result = await pool.query(
        `SELECT ply, classification, cp_loss, created_at
           FROM feedback
          WHERE game_id = $1 AND owner_user_id = $2
          ORDER BY ply`,
        [gameId, ownerUserId]
    );
    return result.rows;
}

module.exports = { insert, findByGame };
