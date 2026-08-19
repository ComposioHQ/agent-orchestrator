-- +goose Up
ALTER TABLE ao_users DROP CONSTRAINT ao_users_auth_provider_check;
ALTER TABLE ao_users ADD CONSTRAINT ao_users_auth_provider_check
    CHECK (auth_provider IN ('google', 'workos', 'local'));

ALTER TABLE ao_organizations DROP CONSTRAINT ao_organizations_auth_provider_check;
ALTER TABLE ao_organizations ADD CONSTRAINT ao_organizations_auth_provider_check
    CHECK (auth_provider IN ('google', 'workos', 'local'));

ALTER TABLE ao_auth_sessions
    ADD COLUMN kind TEXT NOT NULL DEFAULT 'local'
        CHECK (kind IN ('local', 'refresh'));
CREATE INDEX ao_auth_sessions_kind_expiry_idx
    ON ao_auth_sessions(kind, expires_at);

-- +goose Down
DROP INDEX IF EXISTS ao_auth_sessions_kind_expiry_idx;
ALTER TABLE ao_auth_sessions DROP COLUMN kind;

ALTER TABLE ao_organizations DROP CONSTRAINT ao_organizations_auth_provider_check;
ALTER TABLE ao_organizations ADD CONSTRAINT ao_organizations_auth_provider_check
    CHECK (auth_provider IN ('workos', 'local'));

ALTER TABLE ao_users DROP CONSTRAINT ao_users_auth_provider_check;
ALTER TABLE ao_users ADD CONSTRAINT ao_users_auth_provider_check
    CHECK (auth_provider IN ('workos', 'local'));
