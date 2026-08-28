-- name: InsertCodexSessionBinding :exec
INSERT INTO codex_session_bindings (
    session_id, profile_id, profile_source, codex_home, created_at
) VALUES (?, ?, ?, ?, ?);

-- name: GetCodexSessionBinding :one
SELECT session_id, profile_id, profile_source, codex_home, created_at
FROM codex_session_bindings
WHERE session_id = ?;

-- name: ListCodexSessionBindings :many
SELECT session_id, profile_id, profile_source, codex_home, created_at
FROM codex_session_bindings
ORDER BY session_id;
