CREATE TABLE feedback (
    -- SERIAL, not UUID. Like moves.id, this never leaves the server — a verdict
    -- is addressed by game and ply, never by this.
    id             SERIAL PRIMARY KEY,
    -- ON DELETE CASCADE, the same reasoning as moves and rating_history: a
    -- verdict means nothing without the game it was given in.
    game_id        UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    -- Half-move number, 1-based: ply 1 is white's first move, ply 2 is black's.
    ply            INTEGER NOT NULL,
    -- The player who made the move, and the only player who may ever read this
    -- row: feedback is private. Cascades like rating_history.user_id, unlike
    -- games.white_user_id/black_user_id — a game is shared by two players and
    -- must outlive either, but a feedback row belongs to exactly one of them
    -- and means nothing to anyone else once that user is gone.
    owner_user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder' today (longest is
    -- 10). No CHECK: the vocabulary is the team's to grow, and a closed
    -- constraint would turn every new verdict into a schema migration — the
    -- same reason games.mode and games.reason have none.
    classification VARCHAR(16) NOT NULL,
    -- Centipawns the mover lost with this move; 43 means about 0.43 of a pawn.
    -- Unlike classification, non-negativity is a stable invariant rather than
    -- a vocabulary (classification.js clamps the loss at 0), so the database
    -- enforces it.
    cp_loss        INTEGER NOT NULL CHECK (cp_loss >= 0),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- At most one row per move. Each ply has exactly one mover, so the owner
    -- does not need to be part of the key. A verdict written twice fails here
    -- rather than silently duplicating — same principle as moves. Its game_id
    -- prefix also serves the owner-scoped read by game, so no separate index.
    UNIQUE (game_id, ply)
);
