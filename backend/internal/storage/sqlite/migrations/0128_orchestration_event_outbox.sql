-- +goose Up
CREATE TABLE orchestration_events (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    worker_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('worker_turn_settled','worker_blocked','worker_ready_to_merge','worker_terminated','pr_merged')),
    source_revision TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','submitted','acknowledged','dead_letter')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 8),
    enqueued_at TIMESTAMP NOT NULL,
    next_attempt_at TIMESTAMP NOT NULL,
    lease_token TEXT,
    lease_expires_at TIMESTAMP,
    destination_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    submitted_at TIMESTAMP,
    acknowledged_at TIMESTAMP,
    attention_required_at TIMESTAMP,
    last_error TEXT NOT NULL DEFAULT '' CHECK (length(last_error) <= 512),
    UNIQUE(project_id, worker_id, kind, source_revision)
);
CREATE INDEX idx_orchestration_events_due ON orchestration_events(state, next_attempt_at, enqueued_at);
CREATE INDEX idx_orchestration_events_project ON orchestration_events(project_id, state, enqueued_at);
CREATE TABLE orchestration_source_states (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    worker_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    source_id TEXT NOT NULL,
    active INTEGER NOT NULL CHECK(active IN (0,1)),
    generation INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMP NOT NULL,
    PRIMARY KEY(project_id,worker_id,kind,source_id)
);

-- +goose Down
DROP INDEX IF EXISTS idx_orchestration_events_project;
DROP INDEX IF EXISTS idx_orchestration_events_due;
DROP TABLE IF EXISTS orchestration_source_states;
DROP TABLE IF EXISTS orchestration_events;
