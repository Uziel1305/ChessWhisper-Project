CREATE TABLE rating_history (
    -- SERIAL, not UUID. Like moves.id, this never leaves the server — nothing
    -- addresses a rating change by this id, only by (game_id, user_id) — so
    -- the opaque-identifier argument for games.id does not apply here either.
    id            SERIAL PRIMARY KEY,
    -- ON DELETE CASCADE, the opposite of games -> users: a rating_history row
    -- means nothing without the game it came from, the same reasoning that
    -- gives moves its cascade rather than games' RESTRICT.
    game_id       UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    -- Also cascades, unlike games.white_user_id/black_user_id. Those stay
    -- RESTRICT because a game is shared by two players and must outlive
    -- either of them; a rating_history row belongs to exactly one user's own
    -- history and has no meaning to anyone else once that user is gone.
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Both stored rather than just the delta: the delta is derivable from the
    -- two, but a history view (and CW-136's result-dialog line) reads more
    -- naturally off "before -> after" than off a bare signed number.
    rating_before INTEGER NOT NULL,
    rating_after  INTEGER NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A player's own history is looked up by user_id alone (unlike games, there
-- is no colour split here to index around).
CREATE INDEX idx_rating_history_user_id ON rating_history(user_id);
