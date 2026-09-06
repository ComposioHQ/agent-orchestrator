-- +goose Up
-- Durable spawn phase. Before this column a crash between "worktree created" and
-- "controller committed" left no durable trace of how far the spawn got, so the
-- next daemon boot could neither finish the launch nor safely clean it up.
--
--   preparing        seed row exists; no workspace is confirmed to belong to it
--   workspace_ready  worktree + branch + prompt are checkpointed, controller is not
--   controller_ready runtime/controller identity is committed
ALTER TABLE sessions ADD COLUMN spawn_phase TEXT NOT NULL DEFAULT 'controller_ready';

-- Existing live rows that never recorded any controller identity are seeds a
-- previous build abandoned mid-spawn; they must reconcile as interrupted spawns
-- rather than as sessions whose controller merely died. Terminated rows keep
-- controller_ready: their history is closed and must not be re-reconciled.
--
-- The process handles alone are NOT sufficient evidence that no controller ever
-- existed. CommitSessionControllerEpoch clears runtime_handle_id,
-- runtime_launch_id and controller_generation together on a live row while an
-- interface transition is in flight, so an upgrade landing in that window would
-- see a row that merely looks like a seed. Classifying it as preparing would let
-- recovery relaunch it fresh, abandoning its provider conversation and
-- delivering the original prompt a second time. A native or provider identity is
-- therefore treated as proof that a controller did exist, and the row stays
-- controller_ready for the ordinary resume path.
UPDATE sessions SET spawn_phase = 'preparing'
WHERE is_terminated = 0
  AND runtime_handle_id = ''
  AND runtime_launch_id = ''
  AND controller_generation = ''
  AND provider_conversation_id = ''
  AND agent_session_id = '';

-- +goose Down
