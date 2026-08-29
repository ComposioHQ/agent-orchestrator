-- name: InsertCodexProfileSwitch :exec
INSERT INTO codex_profile_switches (
    id, source_session_id, target_session_id, source_profile_id, target_profile_id,
    idempotency_key, request_fingerprint, trigger_kind, phase, recovery_origin_phase,
    workspace_owner, source_generation_id, target_generation_id,
    target_runtime_handle_id, target_controller_generation, target_provider_thread_id,
    semantic_handoff_status, handoff_classification, final_handoff_path, final_handoff_hash,
    acknowledge_unknown_capacity, target_acknowledged_at, source_archived_at,
    requested_at, updated_at, completed_at, error_code, initiator,
    automatic_attempt_id, automatic_policy_revision
) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
);

-- name: GetCodexProfileSwitch :one
SELECT * FROM codex_profile_switches WHERE id = ?;

-- name: GetCodexProfileSwitchByIdempotencyKey :one
SELECT * FROM codex_profile_switches
WHERE source_session_id = ? AND idempotency_key = ?;

-- name: GetActiveCodexProfileSwitch :one
SELECT * FROM codex_profile_switches
WHERE source_session_id = ? AND phase NOT IN ('completed', 'cancelled', 'failed');

-- name: GetCompletedCodexProfileSwitch :one
SELECT * FROM codex_profile_switches
WHERE source_session_id = ? AND phase = 'completed';

-- name: GetCodexProfileSwitchForSession :one
SELECT * FROM codex_profile_switches
WHERE source_session_id = ? OR target_session_id = ?
ORDER BY CASE WHEN phase NOT IN ('completed', 'cancelled', 'failed') THEN 0 ELSE 1 END,
         requested_at DESC, id DESC
LIMIT 1;

-- name: ListCodexProfileSwitches :many
SELECT * FROM codex_profile_switches
WHERE source_session_id = ?
ORDER BY requested_at DESC, id DESC;

-- name: ListActiveCodexProfileSwitches :many
SELECT * FROM codex_profile_switches
WHERE phase NOT IN ('completed', 'cancelled', 'failed')
ORDER BY requested_at, id;

-- name: UpdateCodexProfileSwitch :execrows
UPDATE codex_profile_switches SET
    target_session_id = sqlc.narg(target_session_id),
    phase = sqlc.arg(next_phase),
    recovery_origin_phase = sqlc.narg(recovery_origin_phase),
    workspace_owner = sqlc.arg(workspace_owner),
    target_generation_id = sqlc.arg(target_generation_id),
    target_runtime_handle_id = sqlc.arg(target_runtime_handle_id),
    target_controller_generation = sqlc.arg(target_controller_generation),
    target_provider_thread_id = sqlc.arg(target_provider_thread_id),
    semantic_handoff_status = sqlc.arg(semantic_handoff_status),
    handoff_classification = sqlc.arg(handoff_classification),
    final_handoff_path = sqlc.arg(final_handoff_path),
    final_handoff_hash = sqlc.arg(final_handoff_hash),
    target_acknowledged_at = sqlc.narg(target_acknowledged_at),
    source_archived_at = sqlc.narg(source_archived_at),
    updated_at = sqlc.arg(updated_at),
    completed_at = sqlc.narg(completed_at),
    error_code = sqlc.arg(error_code)
WHERE id = sqlc.arg(id)
  AND source_session_id = sqlc.arg(source_session_id)
  AND phase = sqlc.arg(expected_phase)
  AND source_generation_id = sqlc.arg(expected_source_generation_id)
  AND target_generation_id = sqlc.arg(expected_target_generation_id);

-- name: MoveSessionWorktrees :execrows
UPDATE session_worktrees SET session_id = sqlc.arg(target_session_id)
WHERE session_id = sqlc.arg(source_session_id);

-- name: ArchiveSessionForCodexProfileSwitch :execrows
UPDATE sessions SET archived_at = sqlc.arg(archived_at), updated_at = sqlc.arg(updated_at)
WHERE id = sqlc.arg(id) AND archived_at IS NULL;

-- name: AcknowledgeCodexProfileSwitchTarget :execrows
UPDATE codex_profile_switches SET
    target_acknowledged_at = sqlc.arg(target_acknowledged_at),
    updated_at = MAX(updated_at, sqlc.arg(target_acknowledged_at))
WHERE id = sqlc.arg(id)
  AND target_session_id = sqlc.arg(target_session_id)
  AND phase = 'delivering_handoff'
  AND target_generation_id = sqlc.arg(target_generation_id)
  AND target_generation_id <> ''
  AND target_acknowledged_at IS NULL;

-- name: UnarchiveSessionForCodexProfileSwitch :execrows
UPDATE sessions SET archived_at = NULL, updated_at = sqlc.arg(updated_at)
WHERE id = sqlc.arg(id) AND archived_at IS NOT NULL;
