-- name: InsertConversationTurn :exec
INSERT INTO conversation_turns (id, session_id, conversation_id, role, state, text, client_id, delivery_content_json, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: GetConversationTurn :one
SELECT id, session_id, conversation_id, role, state, text, client_id, delivery_content_json, created_at, updated_at
FROM conversation_turns WHERE id = ?;

-- name: UpdateConversationTurnState :execrows
UPDATE conversation_turns SET state = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND state = ?;

-- name: ListQueuedTurnsBySession :many
SELECT id, session_id, conversation_id, role, state, text, client_id, delivery_content_json, created_at, updated_at
FROM conversation_turns WHERE session_id = ? AND state = 'queued' ORDER BY created_at;
