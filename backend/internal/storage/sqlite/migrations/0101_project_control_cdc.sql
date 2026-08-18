-- Add the project-level invalidation emitted by each distinct successful
-- SetOutcome transaction. The head row is created or revision-bumped exactly
-- once per command, so it is the narrow aggregate boundary for UI CDC.

-- +goose Up
-- +goose StatementBegin
PRAGMA legacy_alter_table=ON;
ALTER TABLE change_log RENAME TO change_log_previous;
CREATE TABLE change_log (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id),
    session_id TEXT REFERENCES sessions(id),
    event_type TEXT NOT NULL CHECK (event_type IN (
        'session_created', 'session_updated', 'pr_created', 'pr_updated',
        'pr_check_recorded', 'pr_session_changed', 'pr_review_thread_added',
        'pr_review_thread_resolved', 'project_file_draft_updated',
        'project_control_updated'
    )),
    payload    TEXT NOT NULL CHECK (json_valid(payload)),
    created_at TIMESTAMP NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO change_log SELECT * FROM change_log_previous;
DROP TABLE change_log_previous;
CREATE INDEX idx_change_log_project ON change_log(project_id, seq);
PRAGMA legacy_alter_table=OFF;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER project_control_heads_cdc_insert
AFTER INSERT ON project_control_heads
BEGIN
    INSERT INTO change_log(project_id, session_id, event_type, payload, created_at)
    VALUES (NEW.project_id, NULL, 'project_control_updated',
        json_object('revision', NEW.revision, 'outcomeId', NEW.root_outcome_id), datetime('now'));
END;
CREATE TRIGGER project_control_heads_cdc_update
AFTER UPDATE OF revision ON project_control_heads
WHEN OLD.revision <> NEW.revision
BEGIN
    INSERT INTO change_log(project_id, session_id, event_type, payload, created_at)
    VALUES (NEW.project_id, NULL, 'project_control_updated',
        json_object('revision', NEW.revision, 'outcomeId', NEW.root_outcome_id), datetime('now'));
END;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TRIGGER project_control_heads_cdc_update;
DROP TRIGGER project_control_heads_cdc_insert;
PRAGMA legacy_alter_table=ON;
ALTER TABLE change_log RENAME TO change_log_with_project_control;
CREATE TABLE change_log (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id),
    session_id TEXT REFERENCES sessions(id),
    event_type TEXT NOT NULL CHECK (event_type IN (
        'session_created', 'session_updated', 'pr_created', 'pr_updated',
        'pr_check_recorded', 'pr_session_changed', 'pr_review_thread_added',
        'pr_review_thread_resolved', 'project_file_draft_updated'
    )),
    payload    TEXT NOT NULL CHECK (json_valid(payload)),
    created_at TIMESTAMP NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO change_log SELECT * FROM change_log_with_project_control
WHERE event_type <> 'project_control_updated';
DROP TABLE change_log_with_project_control;
CREATE INDEX idx_change_log_project ON change_log(project_id, seq);
PRAGMA legacy_alter_table=OFF;
-- +goose StatementEnd
