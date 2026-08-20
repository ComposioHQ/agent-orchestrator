-- +goose Up
-- +goose StatementBegin
-- The resolved permission posture belongs to the session once it starts. In
-- particular, a preventive read-only spawn must not resume with a later project
-- default that grants writes. Empty preserves the pre-migration compatibility
-- behavior for existing sessions.
ALTER TABLE sessions ADD COLUMN permission_mode TEXT NOT NULL DEFAULT ''
    CHECK (permission_mode IN ('', 'default', 'read-only', 'accept-edits', 'auto', 'bypass-permissions'));
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE sessions DROP COLUMN permission_mode;
-- +goose StatementEnd
