CREATE TABLE moves (
    -- SERIAL, not UUID. Unlike games.id this never leaves the server — clients
    -- address a move by game and ply, never by this — so the opaque-identifier
    -- argument does not apply, and 4 bytes beats 16 on what will be the largest
    -- table here (a 40-move game is 80 rows).
    id         SERIAL PRIMARY KEY,
    -- ON DELETE CASCADE, the opposite of games -> users, because the ownership
    -- is different: a move belongs to exactly one game and has no meaning
    -- without it, whereas a game is shared by two players and outlives either.
    game_id    UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    -- Half-move number, 1-based: ply 1 is white's first move, ply 2 is black's.
    ply        INTEGER NOT NULL,
    -- UCI is a fixed format: four characters, or five when a promotion piece is
    -- appended (e7e8q). Unlike games.mode, 5 is provably enough forever.
    uci        VARCHAR(5) NOT NULL,
    -- When the row was written, not a clock reading. Remaining time comes from
    -- clock.js and is not derivable from these timestamps.
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- The real safety property here. A move submitted twice — a client retry, a
    -- race — fails on this constraint instead of silently writing a duplicate
    -- ply and corrupting the game's record. Same principle as users.username:
    -- let the constraint decide rather than checking first.
    UNIQUE (game_id, ply)
);