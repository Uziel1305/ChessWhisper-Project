const pool = require('../pool');

async function insert({ id, userId, tokenHash, familyId, replacedById = null, expiresAt }) {
    await pool.query(
        `INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, replaced_by_id, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, userId, tokenHash, familyId, replacedById, expiresAt]
    );
}

async function findByHash(tokenHash) {
    const result = await pool.query(
        `SELECT id, user_id, token_hash, family_id, replaced_by_id, revoked_at, expires_at
         FROM refresh_tokens WHERE token_hash=$1`,
        [tokenHash]
    );
    // undefined when there is no match, same convention as users.repo.js.
    return result.rows[0];
}

async function revoke(id, replacedById = null) {
    await pool.query(
        `UPDATE refresh_tokens SET revoked_at = now(), replaced_by_id = COALESCE($2, replaced_by_id) WHERE id=$1`,
        [id, replacedById]
    );
}

async function revokeAllForUser(userId) {
    await pool.query(
        `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id=$1 AND revoked_at IS NULL`,
        [userId]
    );
}

module.exports = { insert, findByHash, revoke, revokeAllForUser };
