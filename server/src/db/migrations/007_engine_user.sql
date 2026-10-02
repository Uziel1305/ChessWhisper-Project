-- The engine plays as an ordinary user, so games.white_user_id/black_user_id,
-- the history JOIN and every participant check work for engine games unchanged.
-- DEFAULT false: every existing row is a human, and stays one.
ALTER TABLE users ADD COLUMN is_engine BOOLEAN NOT NULL DEFAULT false;

-- At most one engine user. A partial index, so it constrains only the true rows.
CREATE UNIQUE INDEX users_one_engine ON users (is_engine) WHERE is_engine;

-- The hash is a real argon2 hash of a random 256-bit secret that was never
-- stored, so login as the engine answers a clean 401 (a non-argon2 placeholder
-- would make argon2.verify throw, and the route a 500). Nobody can log in as it,
-- so it never holds a token or a socket.
--
-- ON CONFLICT DO NOTHING: if a human already registered this name, the server
-- must still start. Only engine games are then unavailable (engineOpponent
-- finds no is_engine row and says so); everything that works today keeps working.
INSERT INTO users (username, password_hash, is_engine)
VALUES (
    'ChessWhisper Engine',
    '$argon2id$v=19$m=65536,p=4,t=3$uQR2TSq+MPica+FX8aslVw$Sqa9QaNvJDsruizl2KIqwPF/Fuo+JV4HaSVTHWpulVs',
    true
)
ON CONFLICT (username) DO NOTHING;
