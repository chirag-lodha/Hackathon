-- Users (username + bcrypt password hash).
CREATE TABLE users (
    id            BIGSERIAL PRIMARY KEY,
    created_at    TIMESTAMPTZ,
    updated_at    TIMESTAMPTZ,
    deleted_at    TIMESTAMPTZ,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL
);
CREATE INDEX idx_users_deleted_at ON users (deleted_at);

-- Sessions: a named capture session owned by a user, holding the camera auth
-- key. The auth key is valid for 24h (expires_at), and is later used to fetch
-- the account + its cameras from the upstream API.
CREATE TABLE sessions (
    id         BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,
    user_id    BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    auth_key   TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_sessions_deleted_at ON sessions (deleted_at);
CREATE INDEX idx_sessions_user_id    ON sessions (user_id);
