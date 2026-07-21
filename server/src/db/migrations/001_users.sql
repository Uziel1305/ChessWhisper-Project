CREATE TABLE users (
    id            SERIAL PRIMARY KEY,
    username      VARCHAR(32) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    rating        INTEGER NOT NULL DEFAULT 1200,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);