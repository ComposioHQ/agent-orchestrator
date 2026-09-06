-- +goose Up
-- Durable spawn phase, so a crash between "worktree created" and "controller
-- committed" leaves a trace the next boot can act on. See domain/spawn_phase.go.
ALTER TABLE sessions ADD COLUMN spawn_phase TEXT NOT NULL DEFAULT 'controller_ready';

-- Only live Cursor rows with no controller identity at all are abandoned spawns.
-- Two exclusions carry the weight:
--   - terminated rows are closed history and must not be re-reconciled;
--   - a native or provider id proves a controller existed even when the process
--     handles are empty, because CommitSessionControllerEpoch clears all three
--     together mid interface transition. Treating such a row as a seed would
--     relaunch it fresh, abandoning its conversation and redelivering its prompt.
UPDATE sessions SET spawn_phase = 'preparing'
WHERE is_terminated = 0
  AND harness = 'cursor'
  AND runtime_handle_id = ''
  AND runtime_launch_id = ''
  AND controller_generation = ''
  AND provider_conversation_id = ''
  AND agent_session_id = '';

-- +goose Down
