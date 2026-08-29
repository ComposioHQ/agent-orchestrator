-- name: ResolveCodexAutomaticProfileSwitchChainRoot :one
WITH RECURSIVE ancestors(session_id, depth) AS (
    SELECT CAST(sqlc.arg(session_id) AS TEXT) AS session_id, CAST(0 AS INTEGER) AS depth
    UNION ALL
    SELECT sw.source_session_id, ancestors.depth + 1
    FROM codex_profile_switches sw
    JOIN ancestors ON sw.target_session_id = ancestors.session_id
    WHERE sw.phase = 'completed'
)
SELECT ancestors.session_id AS session_id FROM ancestors ORDER BY ancestors.depth DESC LIMIT 1;

-- name: ListCodexAutomaticProfileSwitchChainSessions :many
WITH RECURSIVE descendants(session_id, depth) AS (
    SELECT CAST(sqlc.arg(root_session_id) AS TEXT) AS session_id, CAST(0 AS INTEGER) AS depth
    UNION ALL
    SELECT sw.target_session_id, descendants.depth + 1
    FROM codex_profile_switches sw
    JOIN descendants ON sw.source_session_id = descendants.session_id
    WHERE sw.phase = 'completed' AND sw.target_session_id IS NOT NULL
)
SELECT descendants.session_id AS session_id FROM descendants ORDER BY descendants.depth, descendants.session_id;

-- name: GetCodexAutomaticProfileSwitchChainRootForSession :one
SELECT chain_root_session_id
FROM codex_automatic_profile_switch_chain_sessions
WHERE session_id = ?;

-- name: GetCodexAutomaticProfileSwitchPolicy :one
SELECT * FROM codex_automatic_profile_switch_policies
WHERE chain_root_session_id = ?;

-- name: ListCodexAutomaticProfileSwitchPolicyProfiles :many
SELECT profile_id, position
FROM codex_automatic_profile_switch_policy_profiles
WHERE chain_root_session_id = ?
ORDER BY position;

-- name: InsertCodexAutomaticProfileSwitchPolicy :exec
INSERT INTO codex_automatic_profile_switch_policies (
    chain_root_session_id, enabled, revision, created_at, updated_at
) VALUES (?, 0, 1, ?, ?);

-- name: InsertCodexAutomaticProfileSwitchChainSession :exec
INSERT INTO codex_automatic_profile_switch_chain_sessions (
    session_id, chain_root_session_id, joined_at
) VALUES (?, ?, ?)
ON CONFLICT(session_id) DO NOTHING;

-- name: InheritCodexAutomaticProfileSwitchChainSession :execrows
INSERT INTO codex_automatic_profile_switch_chain_sessions (
    session_id, chain_root_session_id, joined_at
)
SELECT sqlc.arg(target_session_id), membership.chain_root_session_id, sqlc.arg(joined_at)
FROM codex_automatic_profile_switch_chain_sessions AS membership
WHERE membership.session_id = sqlc.arg(source_session_id)
ON CONFLICT(session_id) DO NOTHING;

-- name: DeleteCodexAutomaticProfileSwitchPolicyProfiles :exec
DELETE FROM codex_automatic_profile_switch_policy_profiles
WHERE chain_root_session_id = ?;

-- name: InsertCodexAutomaticProfileSwitchPolicyProfile :exec
INSERT INTO codex_automatic_profile_switch_policy_profiles (
    chain_root_session_id, position, profile_id
) VALUES (?, ?, ?);

-- name: UpdateCodexAutomaticProfileSwitchPolicyCAS :execrows
UPDATE codex_automatic_profile_switch_policies
SET enabled = sqlc.arg(enabled),
    revision = revision + 1,
    updated_at = sqlc.arg(updated_at)
WHERE chain_root_session_id = sqlc.arg(chain_root_session_id)
  AND revision = sqlc.arg(expected_revision);

-- name: SetInitialCodexAutomaticProfileSwitchPolicy :execrows
UPDATE codex_automatic_profile_switch_policies
SET enabled = sqlc.arg(enabled), updated_at = sqlc.arg(updated_at)
WHERE chain_root_session_id = sqlc.arg(chain_root_session_id)
  AND revision = 1;

-- name: InsertCodexAutomaticProfileSwitchAttempt :exec
INSERT INTO codex_automatic_profile_switch_attempts (
    id, chain_root_session_id, source_session_id, source_profile_id,
    source_generation_id, source_episode_id, trigger_kind,
    exhaustion_fingerprint, policy_revision, selected_profile_id,
    selected_profile_position, profile_switch_id, state, outcome_code,
    created_at, updated_at, completed_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: GetCodexAutomaticProfileSwitchAttempt :one
SELECT * FROM codex_automatic_profile_switch_attempts WHERE id = ?;

-- name: GetCodexAutomaticProfileSwitchAttemptByFingerprint :one
SELECT * FROM codex_automatic_profile_switch_attempts
WHERE exhaustion_fingerprint = ?;

-- name: GetActiveCodexAutomaticProfileSwitchAttempt :one
SELECT * FROM codex_automatic_profile_switch_attempts
WHERE source_session_id = ? AND state IN ('evaluating', 'delegated_to_phase5');

-- name: GetLatestCodexAutomaticProfileSwitchAttempt :one
SELECT * FROM codex_automatic_profile_switch_attempts
WHERE source_session_id = ?
ORDER BY created_at DESC, id DESC
LIMIT 1;

-- name: ListActiveCodexAutomaticProfileSwitchAttempts :many
SELECT * FROM codex_automatic_profile_switch_attempts
WHERE state IN ('evaluating', 'delegated_to_phase5')
ORDER BY created_at, id;

-- name: UpdateCodexAutomaticProfileSwitchAttemptCAS :execrows
UPDATE codex_automatic_profile_switch_attempts SET
    policy_revision = sqlc.arg(policy_revision),
    selected_profile_id = sqlc.narg(selected_profile_id),
    selected_profile_position = sqlc.narg(selected_profile_position),
    profile_switch_id = sqlc.narg(profile_switch_id),
    state = sqlc.arg(next_state),
    outcome_code = sqlc.arg(outcome_code),
    updated_at = sqlc.arg(updated_at),
    completed_at = sqlc.narg(completed_at)
WHERE id = sqlc.arg(id)
  AND state = sqlc.arg(expected_state)
  AND policy_revision = sqlc.arg(expected_policy_revision);

-- name: DeleteCodexAutomaticProfileSwitchAttemptCandidates :exec
DELETE FROM codex_automatic_profile_switch_attempt_candidates
WHERE attempt_id = ?;

-- name: InsertCodexAutomaticProfileSwitchAttemptCandidate :exec
INSERT INTO codex_automatic_profile_switch_attempt_candidates (
    attempt_id, position, profile_id, reason_code, evaluated_at
) VALUES (?, ?, ?, ?, ?);

-- name: ListCodexAutomaticProfileSwitchAttemptCandidates :many
SELECT attempt_id, position, profile_id, reason_code, evaluated_at
FROM codex_automatic_profile_switch_attempt_candidates
WHERE attempt_id = ?
ORDER BY position;

-- name: CompleteCodexAutomaticProfileSwitchAttemptForSwitch :execrows
UPDATE codex_automatic_profile_switch_attempts SET
    state = 'completed',
    outcome_code = 'automatic_switch_completed',
    updated_at = sqlc.arg(completed_at),
    completed_at = sqlc.arg(completed_at)
WHERE id = sqlc.arg(attempt_id)
  AND profile_switch_id = sqlc.arg(profile_switch_id)
  AND state IN ('delegated_to_phase5', 'needs_attention');
