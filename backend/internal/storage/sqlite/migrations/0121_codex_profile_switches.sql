-- Migration 0121: durable assisted Codex profile continuations.
--
-- Capacity and authentication remain daemon-memory observations. This schema
-- retains only the confirmed request, ownership boundaries, immutable handoff
-- reference, continuation relationship, and predecessor archive fact.

-- +goose Up
ALTER TABLE sessions ADD COLUMN archived_at TIMESTAMP;

CREATE TABLE codex_profile_switches (
    id                           TEXT PRIMARY KEY CHECK (length(id) > 0),
    source_session_id            TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    target_session_id            TEXT UNIQUE REFERENCES sessions(id) ON DELETE RESTRICT,
    source_profile_id            TEXT NOT NULL CHECK (length(source_profile_id) > 0),
    target_profile_id            TEXT NOT NULL CHECK (length(target_profile_id) > 0),
    idempotency_key              TEXT NOT NULL CHECK (length(idempotency_key) > 0),
    request_fingerprint          TEXT NOT NULL CHECK (
        length(request_fingerprint) = 67
        AND substr(request_fingerprint, 1, 3) = 'v1:'
        AND substr(request_fingerprint, 4) NOT GLOB '*[^0-9a-f]*'
    ),
    trigger_kind                 TEXT NOT NULL CHECK (trigger_kind IN (
        'manual', 'near_limit', 'exhausted', 'usage_limit_failure'
    )),
    phase                        TEXT NOT NULL CHECK (phase IN (
        'requested', 'waiting_for_safe_boundary', 'preparing_handoff',
        'stopping_source', 'source_stopped', 'starting_target', 'target_ready',
        'delivering_handoff', 'recovery_required', 'completed', 'cancelled', 'failed'
    )),
    recovery_origin_phase        TEXT CHECK (recovery_origin_phase IS NULL OR recovery_origin_phase IN (
        'requested', 'waiting_for_safe_boundary', 'preparing_handoff',
        'stopping_source', 'source_stopped', 'starting_target', 'target_ready',
        'delivering_handoff'
    )),
    workspace_owner              TEXT NOT NULL CHECK (workspace_owner IN ('source', 'switch', 'target', 'recovery')),
    source_generation_id         TEXT NOT NULL,
    target_generation_id         TEXT NOT NULL DEFAULT '',
    target_runtime_handle_id     TEXT NOT NULL DEFAULT '',
    target_controller_generation TEXT NOT NULL DEFAULT '',
    target_provider_thread_id    TEXT NOT NULL DEFAULT '',
    semantic_handoff_status      TEXT NOT NULL DEFAULT 'not_attempted' CHECK (semantic_handoff_status IN (
        'not_attempted', 'requested', 'received', 'unavailable', 'timed_out', 'failed', 'rejected'
    )),
    handoff_classification       TEXT NOT NULL DEFAULT 'pending' CHECK (handoff_classification IN ('pending', 'semantic', 'fallback')),
    final_handoff_path           TEXT NOT NULL DEFAULT '',
    final_handoff_hash           TEXT NOT NULL DEFAULT '',
    acknowledge_unknown_capacity INTEGER NOT NULL DEFAULT 0 CHECK (acknowledge_unknown_capacity IN (0, 1)),
    target_acknowledged_at       TIMESTAMP,
    source_archived_at           TIMESTAMP,
    requested_at                 TIMESTAMP NOT NULL,
    updated_at                   TIMESTAMP NOT NULL,
    completed_at                 TIMESTAMP,
    error_code                   TEXT NOT NULL DEFAULT '' CHECK (error_code IN (
        '', 'source_stop_unconfirmed', 'target_start_unconfirmed', 'delivery_unconfirmed',
        'workspace_recovery_required', 'target_usage_limited', 'target_unavailable',
        'source_restore_unconfirmed', 'request_cancelled', 'daemon_restart', 'switch_failed'
    )),
    UNIQUE (source_session_id, idempotency_key),
    CHECK (source_profile_id <> target_profile_id),
    CHECK (target_session_id IS NULL OR target_session_id <> source_session_id),
    CHECK (updated_at >= requested_at),
    CHECK (
        (final_handoff_path = '' AND final_handoff_hash = '' AND handoff_classification = 'pending')
        OR (
            final_handoff_path <> ''
            AND length(final_handoff_hash) = 64
            AND final_handoff_hash NOT GLOB '*[^0-9a-f]*'
            AND handoff_classification IN ('semantic', 'fallback')
        )
    ),
    CHECK (target_runtime_handle_id = '' OR target_generation_id <> ''),
    CHECK (target_controller_generation = '' OR target_generation_id <> ''),
    CHECK (target_provider_thread_id = '' OR target_generation_id <> ''),
    CHECK (target_acknowledged_at IS NULL OR target_session_id IS NOT NULL),
    CHECK (source_archived_at IS NULL OR target_acknowledged_at IS NOT NULL),
    CHECK (
        (phase = 'completed' AND completed_at IS NOT NULL AND source_archived_at IS NOT NULL AND workspace_owner = 'target')
        OR (phase <> 'completed' AND completed_at IS NULL)
    )
);

CREATE UNIQUE INDEX idx_codex_profile_switches_one_active_source
    ON codex_profile_switches(source_session_id)
    WHERE phase NOT IN ('completed', 'cancelled', 'failed');

CREATE UNIQUE INDEX idx_codex_profile_switches_one_completed_source
    ON codex_profile_switches(source_session_id)
    WHERE phase = 'completed';

CREATE INDEX idx_codex_profile_switches_source_history
    ON codex_profile_switches(source_session_id, requested_at DESC, id DESC);

CREATE INDEX idx_codex_profile_switches_target
    ON codex_profile_switches(target_session_id)
    WHERE target_session_id IS NOT NULL;

-- +goose StatementBegin
CREATE TRIGGER codex_profile_switches_one_successful_continuation
BEFORE INSERT ON codex_profile_switches
WHEN EXISTS (
    SELECT 1 FROM codex_profile_switches
    WHERE source_session_id = NEW.source_session_id AND phase = 'completed'
)
BEGIN
    SELECT RAISE(ABORT, 'source session already has a completed Codex profile continuation');
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER codex_profile_switches_cdc_insert
AFTER INSERT ON codex_profile_switches
BEGIN
    INSERT INTO change_log(project_id, session_id, event_type, payload, created_at)
    SELECT project_id, NEW.source_session_id, 'session_updated',
           json_object('id', NEW.source_session_id, 'codexProfileSwitchId', NEW.id, 'codexProfileSwitchPhase', NEW.phase),
           NEW.updated_at
    FROM sessions WHERE id = NEW.source_session_id;
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER codex_profile_switches_cdc_update
AFTER UPDATE ON codex_profile_switches
BEGIN
    INSERT INTO change_log(project_id, session_id, event_type, payload, created_at)
    SELECT project_id, NEW.source_session_id, 'session_updated',
           json_object('id', NEW.source_session_id, 'codexProfileSwitchId', NEW.id, 'codexProfileSwitchPhase', NEW.phase),
           NEW.updated_at
    FROM sessions WHERE id = NEW.source_session_id;

    INSERT INTO change_log(project_id, session_id, event_type, payload, created_at)
    SELECT project_id, NEW.target_session_id, 'session_updated',
           json_object('id', NEW.target_session_id, 'codexProfileSwitchId', NEW.id, 'codexProfileSwitchPhase', NEW.phase),
           NEW.updated_at
    FROM sessions WHERE NEW.target_session_id IS NOT NULL AND id = NEW.target_session_id;
END;
-- +goose StatementEnd

-- Keep the existing session CDC trigger untouched and publish only archive
-- fact changes from this additive trigger.
-- +goose StatementBegin
CREATE TRIGGER sessions_cdc_profile_archive
AFTER UPDATE OF archived_at ON sessions
WHEN OLD.archived_at IS NOT NEW.archived_at
BEGIN
    INSERT INTO change_log(project_id, session_id, event_type, payload, created_at)
    VALUES (NEW.project_id, NEW.id, 'session_updated',
            json_object('id', NEW.id, 'isArchived', json(CASE WHEN NEW.archived_at IS NULL THEN 'false' ELSE 'true' END)),
            NEW.updated_at);
END;
-- +goose StatementEnd

-- +goose Down
DROP TRIGGER IF EXISTS sessions_cdc_profile_archive;
DROP TRIGGER IF EXISTS codex_profile_switches_cdc_update;
DROP TRIGGER IF EXISTS codex_profile_switches_cdc_insert;
DROP TRIGGER IF EXISTS codex_profile_switches_one_successful_continuation;
DROP INDEX IF EXISTS idx_codex_profile_switches_target;
DROP INDEX IF EXISTS idx_codex_profile_switches_source_history;
DROP INDEX IF EXISTS idx_codex_profile_switches_one_completed_source;
DROP INDEX IF EXISTS idx_codex_profile_switches_one_active_source;
DROP TABLE IF EXISTS codex_profile_switches;
ALTER TABLE sessions DROP COLUMN archived_at;
