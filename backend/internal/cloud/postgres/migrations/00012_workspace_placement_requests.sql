-- +goose Up
-- Request metadata and durable intent for the asynchronous, provider-neutral
-- workspace placement saga. Provider identifiers remain in sandbox_id; none
-- of the request fields contain credentials.
ALTER TABLE ao_cloud_workspaces
    ADD COLUMN display_name TEXT NOT NULL DEFAULT '',
    ADD COLUMN config JSONB,
    ADD COLUMN project_id TEXT,
    ADD COLUMN intent TEXT NOT NULL DEFAULT 'provision'
        CHECK (intent IN ('provision', 'resume', 'delete')),
    ADD COLUMN idempotency_key TEXT
        CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 200),
    ADD COLUMN mutation_idempotency_key TEXT
        CHECK (mutation_idempotency_key IS NULL OR length(mutation_idempotency_key) BETWEEN 1 AND 200),
    ADD COLUMN mutation_intent TEXT
        CHECK (mutation_intent IS NULL OR mutation_intent IN ('resume', 'delete'));

CREATE UNIQUE INDEX ao_cloud_workspaces_create_idempotency_idx
    ON ao_cloud_workspaces(org_id, owner_user_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS ao_cloud_workspaces_create_idempotency_idx;
ALTER TABLE ao_cloud_workspaces
    DROP COLUMN IF EXISTS mutation_intent,
    DROP COLUMN IF EXISTS mutation_idempotency_key,
    DROP COLUMN IF EXISTS idempotency_key,
    DROP COLUMN IF EXISTS intent,
    DROP COLUMN IF EXISTS project_id,
    DROP COLUMN IF EXISTS config,
    DROP COLUMN IF EXISTS display_name;
