-- +goose Up
CREATE TABLE codex_session_bindings (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    profile_id TEXT NOT NULL,
    profile_source TEXT NOT NULL CHECK (profile_source IN ('existing', 'managed', 'legacy')),
    codex_home TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL
);

-- +goose StatementBegin
CREATE TRIGGER codex_session_bindings_cdc_insert
AFTER INSERT ON codex_session_bindings
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    SELECT s.project_id, NEW.session_id, 'session_updated',
        json_object(
            'id', s.id,
            'activity', s.activity_state,
            'isTerminated', json(CASE WHEN s.is_terminated THEN 'true' ELSE 'false' END),
            'codexProfileBound', json('true')
        ),
        NEW.created_at
    FROM sessions s WHERE s.id = NEW.session_id;
END;
-- +goose StatementEnd

-- +goose Down
DROP TRIGGER IF EXISTS codex_session_bindings_cdc_insert;
DROP TABLE IF EXISTS codex_session_bindings;
