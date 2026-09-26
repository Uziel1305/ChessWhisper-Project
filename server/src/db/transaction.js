const pool = require('./pool');

// Runs fn(client) inside one transaction and returns what fn returns. Every
// query that must commit or roll back together has to go through `client`, not
// the shared pool: BEGIN/COMMIT only cover the connection they ran on. A pool
// query touching a row this transaction has already written would also wait on
// the transaction's lock while the transaction waits on it — so inside fn, use
// the client for everything.
//
// Same shape as migrate.js, which does this inline for each migration file.
async function withTransaction(fn) {
    const client = await pool.connect();
    let broken = null;
    try {
        await client.query('BEGIN');
        const value = await fn(client);
        await client.query('COMMIT');
        return value;
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackErr) {
            // The connection itself is unusable. Hand it back as broken so the
            // pool discards it instead of reusing it.
            broken = rollbackErr;
        }
        // The original failure is what the caller needs to see, not the
        // rollback's.
        throw err;
    } finally {
        client.release(broken || undefined);
    }
}

module.exports = { withTransaction };
