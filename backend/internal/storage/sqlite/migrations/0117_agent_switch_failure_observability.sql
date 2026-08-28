-- +goose NO TRANSACTION
-- +goose Up
-- +goose StatementBegin
-- SQLite cannot correct the retained-marker CHECK in place. Rebuild the
-- complete latest agent_switches shape, preserving every column, index, and
-- trigger while adding the stable failure classification point.
PRAGMA foreign_keys=OFF;

CREATE TABLE agent_switches_next (
    id                         TEXT PRIMARY KEY CHECK (length(id) > 0),
    session_id                 TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    idempotency_key            TEXT NOT NULL CHECK (length(idempotency_key) > 0),
    request_fingerprint        TEXT NOT NULL
        CHECK (
            length(request_fingerprint) = 67
            AND substr(request_fingerprint, 1, 3) = 'v1:'
            AND substr(request_fingerprint, 4) NOT GLOB '*[^0-9a-f]*'
        ),
    from_harness               TEXT NOT NULL CHECK (length(from_harness) > 0),
    target_harness             TEXT NOT NULL CHECK (length(target_harness) > 0),
    target_native_session_ref  TEXT REFERENCES agent_native_sessions (id) ON DELETE SET NULL,
    target_start_mode          TEXT NOT NULL DEFAULT '' CHECK (target_start_mode IN ('', 'fresh', 'resumed')),
    state                      TEXT NOT NULL DEFAULT 'preparing_handoff'
        CHECK (state IN ('preparing_handoff', 'stopping_source', 'source_stopped', 'starting_target', 'target_ready', 'delivering_context', 'completed', 'failed')),
    agent_handoff_status       TEXT NOT NULL DEFAULT 'not_attempted'
        CHECK (agent_handoff_status IN ('not_attempted', 'requested', 'received', 'unavailable', 'timed_out', 'failed', 'rejected')),
    source_transcript_status   TEXT NOT NULL DEFAULT 'not_attempted'
        CHECK (source_transcript_status IN ('not_attempted', 'available', 'unavailable')),
    semantic_handoff_included INTEGER NOT NULL DEFAULT 0 CHECK (semantic_handoff_included IN (0, 1)),
    agent_handoff_path         TEXT NOT NULL DEFAULT '',
    agent_handoff_hash         TEXT NOT NULL DEFAULT '',
    source_generation_id       TEXT NOT NULL CHECK (length(source_generation_id) > 0),
    target_generation_id       TEXT NOT NULL DEFAULT '',
    target_runtime_handle_id   TEXT NOT NULL DEFAULT '',
    target_acknowledged_at     TIMESTAMP,
    error_code                 TEXT NOT NULL DEFAULT ''
        CHECK (error_code IN (
            '', 'daemon_restart_pre_stop', 'daemon_restart_post_stop',
            'daemon_restart_unrecoverable_target', 'daemon_restart_before_delivery',
            'delivery_unconfirmed', 'source_session_terminated', 'source_stop_unconfirmed',
            'target_binary_missing', 'target_agent_unauthorized', 'target_start_unconfirmed',
            'source_restore_unconfirmed', 'request_cancelled', 'source_blocked',
            'failed_pre_stop', 'failed_post_stop', 'target_ready_failed', 'delivery_failed', 'switch_failed'
        )),
    failure_point              TEXT NOT NULL DEFAULT '',
    requested_at               TIMESTAMP NOT NULL,
    updated_at                 TIMESTAMP NOT NULL,
    final_handoff_path         TEXT NOT NULL DEFAULT '',
    final_handoff_hash         TEXT NOT NULL DEFAULT '',
    UNIQUE (session_id, idempotency_key),
    CHECK (from_harness <> target_harness),
    CHECK (
        (agent_handoff_status = 'received' AND agent_handoff_path <> '' AND length(agent_handoff_hash) = 64 AND agent_handoff_hash NOT GLOB '*[^0-9a-f]*')
        OR (agent_handoff_status <> 'received' AND agent_handoff_path = '' AND agent_handoff_hash = '')
    ),
    CHECK (state NOT IN ('completed', 'failed') OR agent_handoff_status <> 'requested'),
    CHECK (
        (state = 'failed' AND error_code NOT IN ('', 'source_stop_unconfirmed', 'source_restore_unconfirmed', 'target_start_unconfirmed'))
        OR (state = 'stopping_source' AND error_code = 'source_stop_unconfirmed')
        OR (state IN ('source_stopped', 'starting_target') AND error_code = 'source_restore_unconfirmed')
        OR (state = 'starting_target' AND target_runtime_handle_id = '' AND error_code = 'target_start_unconfirmed')
        OR (state <> 'failed' AND error_code = '')
    ),
    CHECK (updated_at >= requested_at),
    CHECK (target_runtime_handle_id = '' OR target_generation_id <> ''),
    CHECK (target_acknowledged_at IS NULL OR target_generation_id <> ''),
    CHECK (target_acknowledged_at IS NULL OR target_acknowledged_at >= requested_at)
);

INSERT INTO agent_switches_next (
    id, session_id, idempotency_key, request_fingerprint, from_harness, target_harness,
    target_native_session_ref, target_start_mode, state, agent_handoff_status,
    source_transcript_status, semantic_handoff_included, agent_handoff_path, agent_handoff_hash,
    source_generation_id, target_generation_id, target_runtime_handle_id, target_acknowledged_at,
    error_code, failure_point, requested_at, updated_at, final_handoff_path, final_handoff_hash
)
SELECT
    id, session_id, idempotency_key, request_fingerprint, from_harness, target_harness,
    target_native_session_ref, target_start_mode, state, agent_handoff_status,
    source_transcript_status, semantic_handoff_included, agent_handoff_path, agent_handoff_hash,
    source_generation_id, target_generation_id, target_runtime_handle_id, target_acknowledged_at,
    error_code, '', requested_at, updated_at, final_handoff_path, final_handoff_hash
FROM agent_switches;

DROP TABLE agent_switches;
ALTER TABLE agent_switches_next RENAME TO agent_switches;

CREATE UNIQUE INDEX idx_agent_switches_one_active_per_session
    ON agent_switches (session_id) WHERE state NOT IN ('completed', 'failed');
CREATE INDEX idx_agent_switches_session_history
    ON agent_switches (session_id, requested_at DESC, id DESC);

CREATE TRIGGER agent_switches_target_native_scope_insert
BEFORE INSERT ON agent_switches
WHEN NEW.target_native_session_ref IS NOT NULL
    AND NOT EXISTS (
        SELECT 1 FROM agent_native_sessions
        WHERE id = NEW.target_native_session_ref
          AND ao_session_id = NEW.session_id
          AND harness = NEW.target_harness
    )
BEGIN
    SELECT RAISE(ABORT, 'agent switch target native session scope mismatch');
END;

CREATE TRIGGER agent_switches_target_native_scope_update
BEFORE UPDATE OF session_id, target_harness, target_native_session_ref ON agent_switches
WHEN NEW.target_native_session_ref IS NOT NULL
    AND NOT EXISTS (
        SELECT 1 FROM agent_native_sessions
        WHERE id = NEW.target_native_session_ref
          AND ao_session_id = NEW.session_id
          AND harness = NEW.target_harness
    )
BEGIN
    SELECT RAISE(ABORT, 'agent switch target native session scope mismatch');
END;

CREATE TRIGGER agent_switches_cdc_insert
AFTER INSERT ON agent_switches
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (
        (SELECT project_id FROM sessions WHERE id = NEW.session_id),
        NEW.session_id, 'session_updated', json_object('id', NEW.session_id), NEW.updated_at
    );
END;

CREATE TRIGGER agent_switches_cdc_update
AFTER UPDATE ON agent_switches
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (
        (SELECT project_id FROM sessions WHERE id = NEW.session_id),
        NEW.session_id, 'session_updated', json_object('id', NEW.session_id), NEW.updated_at
    );
END;

CREATE TABLE agent_switch_failure_policy (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    consent_generation TEXT NOT NULL,
    destination_fingerprint TEXT NOT NULL,
    updated_at TIMESTAMP NOT NULL
);

INSERT INTO agent_switch_failure_policy (
    singleton, enabled, consent_generation, destination_fingerprint, updated_at
) VALUES (1, 0, '', '', CURRENT_TIMESTAMP);

CREATE TABLE agent_switch_failure_receipts (
    dedupe_key TEXT PRIMARY KEY,
    switch_id TEXT REFERENCES agent_switches(id) ON DELETE CASCADE,
    report_kind TEXT NOT NULL,
    durable_state_fingerprint TEXT NOT NULL,
    recorded_at TIMESTAMP NOT NULL,
    retain_until TIMESTAMP
);

CREATE TABLE agent_switch_failure_outbox (
    id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    envelope_encoding_version INTEGER NOT NULL,
    dedupe_key TEXT NOT NULL UNIQUE,
    destination_fingerprint TEXT NOT NULL,
    switch_id TEXT,
    report_kind TEXT NOT NULL,
    scope TEXT NOT NULL,
    failure_point TEXT NOT NULL,
    classifier_callsite TEXT NOT NULL,
    phase TEXT NOT NULL,
    error_code TEXT NOT NULL,
    fault_code TEXT NOT NULL,
    execution TEXT NOT NULL,
    execution_attempt_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    from_harness TEXT NOT NULL,
    target_harness TEXT NOT NULL,
    target_start_mode TEXT NOT NULL,
    runtime_backend TEXT NOT NULL,
    call_outcome TEXT NOT NULL,
    ownership TEXT NOT NULL,
    compensation TEXT NOT NULL,
    user_impact TEXT NOT NULL,
    source_stop_confirmed TEXT NOT NULL,
    target_owner_committed TEXT NOT NULL,
    gate_retained TEXT NOT NULL,
    requested_at TIMESTAMP,
    occurred_at TIMESTAMP NOT NULL,
    sanitized_stack BLOB NOT NULL,
    stack_fingerprint TEXT NOT NULL,
    canonical_event_json BLOB NOT NULL CHECK (length(canonical_event_json) <= 61440),
    expires_at TIMESTAMP NOT NULL,
    available_at TIMESTAMP NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TIMESTAMP,
    lease_token TEXT,
    lease_consent_generation TEXT,
    lease_delivery_epoch INTEGER,
    lease_expires_at TIMESTAMP,
    delivered_at TIMESTAMP,
    discarded_at TIMESTAMP,
    last_delivery_error_class TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_agent_switch_failure_outbox_pending
    ON agent_switch_failure_outbox(available_at, occurred_at)
    WHERE delivered_at IS NULL AND discarded_at IS NULL;

CREATE TABLE agent_switch_failure_delivery_state (
    destination_fingerprint TEXT PRIMARY KEY,
    error_not_before TIMESTAMP,
    all_not_before TIMESTAMP
);

PRAGMA foreign_keys=ON;
PRAGMA foreign_key_check;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- Rows may depend on the corrected retained-marker constraint and failure
-- payload tables, so a safe downgrade is intentionally unavailable.
SELECT 1;
-- +goose StatementEnd
