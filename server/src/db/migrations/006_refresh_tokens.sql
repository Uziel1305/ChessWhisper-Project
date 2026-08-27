CREATE TABLE refresh_tokens (
    id             UUID PRIMARY KEY,
    -- users.id is a plain SERIAL, so this stays INTEGER rather than UUID.
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- SHA-256 hex digest of the opaque refresh token; UNIQUE doubles as the
    -- O(1) lookup index the hashed-token design relies on.
    token_hash     CHAR(64) NOT NULL UNIQUE,
    -- Groups every token descended from one login, so a theft/replay can
    -- revoke the whole chain in one UPDATE.
    family_id      UUID NOT NULL,
    replaced_by_id UUID REFERENCES refresh_tokens(id),
    revoked_at     TIMESTAMPTZ,
    expires_at     TIMESTAMPTZ NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);
