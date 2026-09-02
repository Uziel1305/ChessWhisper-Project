CREATE TABLE games (
    -- UUID rather than SERIAL because the id reaches the client as gameId, and
    -- because GameManager needs it before the row exists: the game is created in
    -- memory, keyed by this id, and only then persisted. A SERIAL would force a
    -- round trip to the database before match.found could be sent.
    id              UUID PRIMARY KEY,
    -- users.id is a plain SERIAL, so these stay INTEGER rather than UUID. No
    -- ON DELETE CASCADE, unlike refresh_tokens: deleting one player must not
    -- silently erase their opponent's history along with their own.
    white_user_id   INTEGER NOT NULL REFERENCES users(id),
    black_user_id   INTEGER NOT NULL REFERENCES users(id),
    -- Half the matchmaking key, stored so a finished game records what it was
    -- actually played as. No CHECK yet — CW-38 is what pins the vocabulary.
    mode            VARCHAR(16) NOT NULL,
    -- The other half. Here from the first version because the time control is a
    -- constructor argument and never a literal.
    time_control_ms INTEGER NOT NULL,
    -- NULL means "still playing". PGN notation, and the CHECK is safe because
    -- chess has exactly these three outcomes and always will.
    result          VARCHAR(7) CHECK (result IN ('1-0', '0-1', '1/2-1/2')),
    -- checkmate, stalemate, resign, timeout today. Deliberately unconstrained:
    -- the draw reasons (threefold, insufficient material) land later, and a
    -- CHECK here would mean a migration per reason.
    reason          VARCHAR(24),
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Written together with result. NULL is what "in progress" means.
    ended_at        TIMESTAMPTZ
);

-- A player's history is "games where I was either colour", which Postgres cannot
-- serve from a single index across an OR. Two indexes, one per column.
CREATE INDEX idx_games_white_user_id ON games(white_user_id);
CREATE INDEX idx_games_black_user_id ON games(black_user_id);