-- Claude Code account-management state.
-- +goose Up
CREATE TABLE claude_code_active_account (
    singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
    account_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    activated_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL
);

CREATE TABLE claude_code_account_switches (
    id TEXT PRIMARY KEY,
    source_account_id TEXT NOT NULL,
    target_account_id TEXT NOT NULL,
    switch_policy TEXT NOT NULL CHECK (switch_policy = 'hot_reload'),
    idempotency_key TEXT NOT NULL UNIQUE,
    request_fingerprint TEXT NOT NULL,
    expected_account_revision INTEGER NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN (
        'requested', 'verifying_target', 'checkpointing_source',
        'activating_target', 'updating_identity', 'verifying_global',
        'rollback_required', 'recovery_required', 'completed', 'failed'
    )),
    failure_code TEXT NOT NULL DEFAULT '',
    credentials_committed_at TIMESTAMP,
    propagation_uncertain_until TIMESTAMP,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    completed_at TIMESTAMP
);

CREATE UNIQUE INDEX idx_claude_code_account_switches_one_active
ON claude_code_account_switches((1))
WHERE phase NOT IN ('completed', 'failed');

-- +goose Down
DROP INDEX IF EXISTS idx_claude_code_account_switches_one_active;
DROP TABLE IF EXISTS claude_code_account_switches;
DROP TABLE IF EXISTS claude_code_active_account;
