-- +goose Up
-- +goose StatementBegin
CREATE TABLE conversation_turns (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'human',
    state TEXT NOT NULL DEFAULT 'queued',
    text TEXT NOT NULL DEFAULT '',
    client_id TEXT NOT NULL DEFAULT '',
    delivery_content_json TEXT NOT NULL DEFAULT '',
    created_at DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_conversation_turns_session_state ON conversation_turns(session_id, state);
CREATE INDEX idx_conversation_turns_conversation ON conversation_turns(conversation_id);

-- Keep updated_at fresh; not CDC, just local timestamp.
CREATE TRIGGER trg_conversation_turns_updated
AFTER UPDATE ON conversation_turns
FOR EACH ROW
BEGIN
    UPDATE conversation_turns SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TRIGGER IF EXISTS trg_conversation_turns_updated;
DROP TABLE IF EXISTS conversation_turns;
-- +goose StatementEnd
