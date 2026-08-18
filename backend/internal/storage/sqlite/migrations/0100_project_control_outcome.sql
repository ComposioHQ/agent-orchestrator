-- Slice one of outcome-centric project control. Existing projects are left
-- unconfigured: the first successful SetOutcome transaction creates the head
-- and root outcome at project-local revision 1.

-- +goose Up
-- +goose StatementBegin
CREATE TABLE project_control_heads (
    project_id       TEXT PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
    root_outcome_id  TEXT NOT NULL UNIQUE,
    revision         INTEGER NOT NULL CHECK (revision >= 1),
    owner_role       TEXT NOT NULL DEFAULT 'role:project-owner'
        CHECK (owner_role = 'role:project-owner'),
    UNIQUE (project_id, root_outcome_id)
);

CREATE TABLE project_control_outcomes (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL UNIQUE REFERENCES project_control_heads (project_id) ON DELETE CASCADE,
    statement   TEXT NOT NULL CHECK (length(trim(statement)) > 0),
    FOREIGN KEY (project_id, id)
        REFERENCES project_control_heads (project_id, root_outcome_id)
        DEFERRABLE INITIALLY DEFERRED,
    UNIQUE (project_id, id)
);

CREATE TABLE project_control_acceptance_criteria (
    id            TEXT PRIMARY KEY,
    outcome_id    TEXT NOT NULL REFERENCES project_control_outcomes (id) ON DELETE CASCADE,
    statement     TEXT NOT NULL CHECK (length(trim(statement)) > 0),
    verification_method TEXT NOT NULL CHECK (length(trim(verification_method)) > 0),
    display_order INTEGER NOT NULL CHECK (display_order >= 0),
    UNIQUE (outcome_id, display_order)
);
CREATE INDEX idx_project_control_criteria_order
    ON project_control_acceptance_criteria (outcome_id, display_order);

-- The saved result is the authoritative response to a successful retry. It
-- preserves server-generated IDs and the exact committed revision/content.
CREATE TABLE project_control_set_results (
    project_id         TEXT NOT NULL REFERENCES project_control_heads (project_id) ON DELETE CASCADE,
    idempotency_key    TEXT NOT NULL CHECK (length(idempotency_key) > 0),
    request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) > 0),
    revision           INTEGER NOT NULL CHECK (revision >= 1),
    result_json        TEXT NOT NULL CHECK (json_valid(result_json)),
    PRIMARY KEY (project_id, idempotency_key),
    UNIQUE (project_id, revision)
);

-- This is the durable project-control command event, not the daemon CDC/SSE
-- stream. Slice one writes exactly one event in the same transaction as each
-- distinct successful SetOutcome command and does not add CDC triggers.
CREATE TABLE project_control_events (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  TEXT NOT NULL REFERENCES project_control_heads (project_id) ON DELETE CASCADE,
    outcome_id  TEXT NOT NULL REFERENCES project_control_outcomes (id) ON DELETE CASCADE,
    revision    INTEGER NOT NULL CHECK (revision >= 1),
    event_type  TEXT NOT NULL CHECK (event_type = 'outcome.set'),
    payload     TEXT NOT NULL CHECK (json_valid(payload)),
    created_at  TIMESTAMP NOT NULL,
    UNIQUE (project_id, revision)
);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE project_control_events;
DROP TABLE project_control_set_results;
DROP TABLE project_control_acceptance_criteria;
DROP TABLE project_control_outcomes;
DROP TABLE project_control_heads;
-- +goose StatementEnd
