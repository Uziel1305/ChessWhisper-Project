const { Pool } = require('pg');

// One shared pool for the whole process. Connections are reused instead of
// opened per query, which matters because a Postgres connection is expensive
// to establish and the server is long-lived.
const pool = new Pool({
  // Set by compose from .env. Inside the compose network the host is "db",
  // the service name — not localhost.
  connectionString: process.env.DATABASE_URL,
});

module.exports = pool;