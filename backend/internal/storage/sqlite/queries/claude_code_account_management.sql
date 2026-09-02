-- name: GetClaudeCodeActiveAccount :one
SELECT account_id, revision, activated_at, updated_at
FROM claude_code_active_account WHERE singleton_id = 1;

-- name: InsertClaudeCodeActiveAccount :execrows
INSERT INTO claude_code_active_account (singleton_id, account_id, revision, activated_at, updated_at)
VALUES (1, sqlc.arg(account_id), 1, sqlc.arg(activated_at), sqlc.arg(updated_at))
ON CONFLICT DO NOTHING;

-- name: UpdateClaudeCodeActiveAccount :execrows
UPDATE claude_code_active_account
SET account_id = sqlc.arg(account_id), revision = revision + 1,
    activated_at = sqlc.arg(activated_at), updated_at = sqlc.arg(updated_at)
WHERE singleton_id = 1 AND revision = sqlc.arg(expected_revision);

-- name: InsertClaudeCodeAccountSwitch :execrows
INSERT INTO claude_code_account_switches (
    id, source_account_id, target_account_id, switch_policy,
    idempotency_key, request_fingerprint, expected_account_revision,
    phase, failure_code, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)
ON CONFLICT DO NOTHING;

-- name: GetClaudeCodeAccountSwitch :one
SELECT id, source_account_id, target_account_id, switch_policy,
       idempotency_key, request_fingerprint, expected_account_revision,
       phase, failure_code, credentials_committed_at,
       propagation_uncertain_until, created_at, updated_at, completed_at
FROM claude_code_account_switches WHERE id = ?;

-- name: GetClaudeCodeAccountSwitchByIdempotency :one
SELECT id, source_account_id, target_account_id, switch_policy,
       idempotency_key, request_fingerprint, expected_account_revision,
       phase, failure_code, credentials_committed_at,
       propagation_uncertain_until, created_at, updated_at, completed_at
FROM claude_code_account_switches WHERE idempotency_key = ?;

-- name: GetActiveClaudeCodeAccountSwitch :one
SELECT id, source_account_id, target_account_id, switch_policy,
       idempotency_key, request_fingerprint, expected_account_revision,
       phase, failure_code, credentials_committed_at,
       propagation_uncertain_until, created_at, updated_at, completed_at
FROM claude_code_account_switches
WHERE phase NOT IN ('completed', 'failed')
ORDER BY created_at LIMIT 1;

-- name: UpdateClaudeCodeAccountSwitchPhase :execrows
UPDATE claude_code_account_switches
SET phase = sqlc.arg(next_phase), failure_code = sqlc.arg(failure_code),
    credentials_committed_at = sqlc.narg(credentials_committed_at),
    propagation_uncertain_until = sqlc.narg(propagation_uncertain_until),
    updated_at = sqlc.arg(updated_at), completed_at = sqlc.narg(completed_at)
WHERE id = sqlc.arg(id) AND phase = sqlc.arg(expected_phase);
