CREATE TABLE users (
    id            SERIAL PRIMARY KEY,
    -- UNIQUE is what actually enforces "no duplicate usernames"; the 409 in
    -- auth.routes.js is just this constraint being reported to the client.
    username      VARCHAR(32) UNIQUE NOT NULL,
    -- Holds an argon2 string (~95 chars incl. salt and parameters), never a
    -- password. TEXT rather than a fixed width so the cost settings can change.
    password_hash TEXT NOT NULL,
    -- Every new player starts here, per CW-1 and CW-12. Elo adjustments move it.
    rating        INTEGER NOT NULL DEFAULT 1000,
    -- TIMESTAMPTZ, so the value is stored as an absolute instant and does not
    -- shift with the server's timezone.
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);