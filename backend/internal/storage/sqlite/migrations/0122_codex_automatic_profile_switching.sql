-- Migration 0122: chain-scoped Codex automatic profile switching.
--
-- The durable rows contain only explicit policy, safe evaluation decisions,
-- and linkage to the Phase 5 switch engine. Authentication, provider capacity,
-- reset times, credentials, Codex homes, and handoff content remain outside
-- these tables.

-- +goose Up
CREATE TABLE codex_automatic_profile_switch_policies (
    chain_root_session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    enabled               INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    revision              INTEGER NOT NULL CHECK (revision >= 1),
    created_at            TIMESTAMP NOT NULL,
    updated_at            TIMESTAMP NOT NULL,
    CHECK (updated_at >= created_at)
);

CREATE TABLE codex_automatic_profile_switch_chain_sessions (
    session_id            TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    chain_root_session_id TEXT NOT NULL REFERENCES codex_automatic_profile_switch_policies(chain_root_session_id) ON DELETE CASCADE,
    joined_at             TIMESTAMP NOT NULL
);

CREATE INDEX idx_codex_automatic_profile_switch_chain_sessions_root
    ON codex_automatic_profile_switch_chain_sessions(chain_root_session_id, joined_at, session_id);

CREATE TABLE codex_automatic_profile_switch_policy_profiles (
    chain_root_session_id TEXT NOT NULL REFERENCES codex_automatic_profile_switch_policies(chain_root_session_id) ON DELETE CASCADE,
    position              INTEGER NOT NULL CHECK (position >= 0),
    profile_id            TEXT NOT NULL CHECK (length(profile_id) > 0),
    PRIMARY KEY (chain_root_session_id, position),
    UNIQUE (chain_root_session_id, profile_id)
);

CREATE TABLE codex_automatic_profile_switch_attempts (
    id                        TEXT PRIMARY KEY CHECK (length(id) > 0),
    chain_root_session_id     TEXT NOT NULL REFERENCES codex_automatic_profile_switch_policies(chain_root_session_id) ON DELETE CASCADE,
    source_session_id         TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    source_profile_id         TEXT NOT NULL CHECK (length(source_profile_id) > 0),
    source_generation_id      TEXT NOT NULL CHECK (length(source_generation_id) > 0),
    source_episode_id         TEXT NOT NULL CHECK (length(source_episode_id) > 0),
    trigger_kind              TEXT NOT NULL CHECK (trigger_kind IN ('usage_limit_failure', 'capacity_event', 'capacity_read')),
    exhaustion_fingerprint    TEXT NOT NULL UNIQUE CHECK (
        length(exhaustion_fingerprint) = 67
        AND substr(exhaustion_fingerprint, 1, 3) = 'v1:'
        AND substr(exhaustion_fingerprint, 4) NOT GLOB '*[^0-9a-f]*'
    ),
    policy_revision           INTEGER NOT NULL CHECK (policy_revision >= 1),
    selected_profile_id       TEXT,
    selected_profile_position INTEGER CHECK (selected_profile_position IS NULL OR selected_profile_position >= 0),
    profile_switch_id         TEXT UNIQUE REFERENCES codex_profile_switches(id) ON DELETE RESTRICT,
    state                     TEXT NOT NULL CHECK (state IN (
        'evaluating', 'no_candidate', 'delegated_to_phase5', 'completed', 'needs_attention', 'cancelled'
    )),
    outcome_code              TEXT NOT NULL CHECK (outcome_code IN (
        'automatic_switch_evaluating', 'automatic_switch_policy_disabled',
        'automatic_switch_policy_changed', 'automatic_switch_source_available',
        'automatic_switch_source_unverified', 'automatic_switch_source_not_current',
        'automatic_switch_no_candidate', 'automatic_switch_cancelled',
        'automatic_switch_delegated', 'automatic_switch_completed',
        'automatic_switch_needs_attention'
    )),
    created_at                TIMESTAMP NOT NULL,
    updated_at                TIMESTAMP NOT NULL,
    completed_at              TIMESTAMP,
    CHECK (updated_at >= created_at),
    CHECK ((selected_profile_id IS NULL) = (selected_profile_position IS NULL)),
    CHECK (
        (state IN ('delegated_to_phase5', 'completed', 'needs_attention') AND profile_switch_id IS NOT NULL)
        OR (state NOT IN ('delegated_to_phase5', 'completed', 'needs_attention'))
    ),
    CHECK (
        (state IN ('no_candidate', 'completed', 'needs_attention', 'cancelled') AND completed_at IS NOT NULL)
        OR (state IN ('evaluating', 'delegated_to_phase5') AND completed_at IS NULL)
    )
);

CREATE UNIQUE INDEX idx_codex_automatic_profile_switch_one_active_source
    ON codex_automatic_profile_switch_attempts(source_session_id)
    WHERE state IN ('evaluating', 'delegated_to_phase5');

CREATE INDEX idx_codex_automatic_profile_switch_attempts_chain
    ON codex_automatic_profile_switch_attempts(chain_root_session_id, created_at DESC, id DESC);

CREATE INDEX idx_codex_automatic_profile_switch_attempts_source
    ON codex_automatic_profile_switch_attempts(source_session_id, created_at DESC, id DESC);

CREATE TABLE codex_automatic_profile_switch_attempt_candidates (
    attempt_id   TEXT NOT NULL REFERENCES codex_automatic_profile_switch_attempts(id) ON DELETE CASCADE,
    position     INTEGER NOT NULL CHECK (position >= 0),
    profile_id   TEXT NOT NULL CHECK (length(profile_id) > 0),
    reason_code  TEXT NOT NULL CHECK (length(reason_code) > 0),
    evaluated_at TIMESTAMP NOT NULL,
    PRIMARY KEY (attempt_id, position),
    UNIQUE (attempt_id, profile_id)
);

ALTER TABLE codex_profile_switches
    ADD COLUMN initiator TEXT NOT NULL DEFAULT 'manual' CHECK (initiator IN ('manual', 'automatic'));
ALTER TABLE codex_profile_switches
    ADD COLUMN automatic_attempt_id TEXT REFERENCES codex_automatic_profile_switch_attempts(id) ON DELETE RESTRICT;
ALTER TABLE codex_profile_switches
    ADD COLUMN automatic_policy_revision INTEGER CHECK (automatic_policy_revision IS NULL OR automatic_policy_revision >= 1);

CREATE UNIQUE INDEX idx_codex_profile_switches_automatic_attempt
    ON codex_profile_switches(automatic_attempt_id)
    WHERE automatic_attempt_id IS NOT NULL;

-- +goose StatementBegin
CREATE TRIGGER codex_automatic_profile_switch_policy_requires_profiles
BEFORE UPDATE OF enabled ON codex_automatic_profile_switch_policies
WHEN NEW.enabled = 1 AND NOT EXISTS (
    SELECT 1 FROM codex_automatic_profile_switch_policy_profiles
    WHERE chain_root_session_id = NEW.chain_root_session_id
)
BEGIN
    SELECT RAISE(ABORT, 'enabled automatic profile switch policy requires a profile');
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER codex_automatic_profile_switch_policy_cdc_insert
AFTER INSERT ON codex_automatic_profile_switch_policies
BEGIN
    INSERT INTO change_log(project_id, session_id, event_type, payload, created_at)
    SELECT s.project_id, m.session_id, 'session_updated',
           json_object('id', m.session_id, 'automaticCodexProfileSwitchPolicyRevision', NEW.revision),
           NEW.updated_at
    FROM codex_automatic_profile_switch_chain_sessions m
    JOIN sessions s ON s.id = m.session_id
    WHERE m.chain_root_session_id = NEW.chain_root_session_id;
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER codex_automatic_profile_switch_policy_cdc_update
AFTER UPDATE ON codex_automatic_profile_switch_policies
BEGIN
    INSERT INTO change_log(project_id, session_id, event_type, payload, created_at)
    SELECT s.project_id, m.session_id, 'session_updated',
           json_object('id', m.session_id, 'automaticCodexProfileSwitchPolicyRevision', NEW.revision),
           NEW.updated_at
    FROM codex_automatic_profile_switch_chain_sessions m
    JOIN sessions s ON s.id = m.session_id
    WHERE m.chain_root_session_id = NEW.chain_root_session_id;
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER codex_automatic_profile_switch_membership_cdc_insert
AFTER INSERT ON codex_automatic_profile_switch_chain_sessions
BEGIN
    INSERT INTO change_log(project_id, session_id, event_type, payload, created_at)
    SELECT project_id, NEW.session_id, 'session_updated',
           json_object('id', NEW.session_id, 'automaticCodexProfileSwitchChainRootSessionId', NEW.chain_root_session_id),
           NEW.joined_at
    FROM sessions WHERE id = NEW.session_id;
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER codex_automatic_profile_switch_attempt_cdc_insert
AFTER INSERT ON codex_automatic_profile_switch_attempts
BEGIN
    INSERT INTO change_log(project_id, session_id, event_type, payload, created_at)
    SELECT project_id, NEW.source_session_id, 'session_updated',
           json_object('id', NEW.source_session_id, 'automaticCodexProfileSwitchAttemptId', NEW.id, 'automaticCodexProfileSwitchState', NEW.state),
           NEW.updated_at
    FROM sessions WHERE id = NEW.source_session_id;
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER codex_automatic_profile_switch_attempt_cdc_update
AFTER UPDATE ON codex_automatic_profile_switch_attempts
BEGIN
    INSERT INTO change_log(project_id, session_id, event_type, payload, created_at)
    SELECT project_id, NEW.source_session_id, 'session_updated',
           json_object('id', NEW.source_session_id, 'automaticCodexProfileSwitchAttemptId', NEW.id, 'automaticCodexProfileSwitchState', NEW.state),
           NEW.updated_at
    FROM sessions WHERE id = NEW.source_session_id;
END;
-- +goose StatementEnd

-- +goose Down
DROP TRIGGER IF EXISTS codex_automatic_profile_switch_attempt_cdc_update;
DROP TRIGGER IF EXISTS codex_automatic_profile_switch_attempt_cdc_insert;
DROP TRIGGER IF EXISTS codex_automatic_profile_switch_membership_cdc_insert;
DROP TRIGGER IF EXISTS codex_automatic_profile_switch_policy_cdc_update;
DROP TRIGGER IF EXISTS codex_automatic_profile_switch_policy_cdc_insert;
DROP TRIGGER IF EXISTS codex_automatic_profile_switch_policy_requires_profiles;
DROP INDEX IF EXISTS idx_codex_profile_switches_automatic_attempt;
ALTER TABLE codex_profile_switches DROP COLUMN automatic_policy_revision;
ALTER TABLE codex_profile_switches DROP COLUMN automatic_attempt_id;
ALTER TABLE codex_profile_switches DROP COLUMN initiator;
DROP TABLE IF EXISTS codex_automatic_profile_switch_attempt_candidates;
DROP INDEX IF EXISTS idx_codex_automatic_profile_switch_attempts_source;
DROP INDEX IF EXISTS idx_codex_automatic_profile_switch_attempts_chain;
DROP INDEX IF EXISTS idx_codex_automatic_profile_switch_one_active_source;
DROP TABLE IF EXISTS codex_automatic_profile_switch_attempts;
DROP TABLE IF EXISTS codex_automatic_profile_switch_policy_profiles;
DROP INDEX IF EXISTS idx_codex_automatic_profile_switch_chain_sessions_root;
DROP TABLE IF EXISTS codex_automatic_profile_switch_chain_sessions;
DROP TABLE IF EXISTS codex_automatic_profile_switch_policies;
