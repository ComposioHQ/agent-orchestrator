-- name: UpsertUsageBinding :one
INSERT INTO usage_bindings (
    session_id, harness, native_root_id, initial_model_id, state,
    last_error_code, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (session_id, harness, native_root_id) DO UPDATE SET
    initial_model_id = CASE
        WHEN excluded.initial_model_id <> '' THEN excluded.initial_model_id
        ELSE usage_bindings.initial_model_id
    END,
    state = CASE
        WHEN usage_bindings.state IN ('finalizing', 'complete', 'partial')
          AND excluded.state IN ('discovering', 'active')
        THEN usage_bindings.state
        ELSE excluded.state
    END,
    last_error_code = CASE
        WHEN usage_bindings.last_error_code = 'codex_source_budget_exceeded'
        THEN usage_bindings.last_error_code
        WHEN usage_bindings.state IN ('finalizing', 'complete', 'partial')
          AND excluded.state IN ('discovering', 'active')
        THEN usage_bindings.last_error_code
        ELSE excluded.last_error_code
    END,
    updated_at = excluded.updated_at
RETURNING *;

-- name: GetUsageBindingBySessionHarnessRoot :one
SELECT *
FROM usage_bindings
WHERE session_id = ? AND harness = ? AND native_root_id = ?;

-- name: ListUsageBindingsForSession :many
SELECT *
FROM usage_bindings
WHERE session_id = ?
ORDER BY updated_at, id;

-- name: FinalizeUsageBindingsForSessionLaunch :many
UPDATE usage_bindings
SET state = 'finalizing',
    last_error_code = CASE
        WHEN usage_bindings.last_error_code = 'codex_source_budget_exceeded'
        THEN usage_bindings.last_error_code
        ELSE ''
    END,
    updated_at = sqlc.arg(finalized_at)
WHERE usage_bindings.session_id = sqlc.arg(session_id)
  AND EXISTS (
      SELECT 1
      FROM sessions
      WHERE sessions.id = usage_bindings.session_id
        AND sessions.runtime_launch_id = sqlc.arg(expected_runtime_launch_id)
        AND sessions.updated_at = sqlc.arg(expected_session_updated_at)
        AND sessions.is_terminated = 0
  )
RETURNING *;

-- name: InsertUsageSource :one
INSERT INTO usage_sources (
    binding_id, kind, native_session_id, subagent_id, artifact_path,
    file_identity, generation, byte_offset, parser_state_json,
    state, failure_count, anomaly_count, next_retry_at, last_error_code,
    updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (binding_id, artifact_path, generation) DO UPDATE SET
    native_session_id = CASE
        WHEN excluded.native_session_id <> '' THEN excluded.native_session_id
        ELSE usage_sources.native_session_id
    END,
    subagent_id = CASE
        WHEN excluded.subagent_id <> '' THEN excluded.subagent_id
        ELSE usage_sources.subagent_id
    END,
    updated_at = excluded.updated_at
RETURNING *;

-- name: ListUsageSourcesForBinding :many
SELECT *
FROM usage_sources
WHERE binding_id = ?
ORDER BY generation, id;

-- name: ListWatchableUsageSources :many
SELECT us.*
FROM usage_sources us
JOIN usage_bindings ub ON ub.id = us.binding_id
JOIN sessions s ON s.id = ub.session_id
WHERE (s.is_terminated = 0 OR ub.state = 'finalizing')
  AND NOT (
      us.state = 'complete'
      AND us.last_error_code = 'artifact_replaced'
  )
  AND us.id = (
      SELECT latest.id
      FROM usage_sources latest
      WHERE latest.binding_id = us.binding_id
        AND latest.artifact_path = us.artifact_path
      ORDER BY latest.generation DESC, latest.id DESC
      LIMIT 1
  )
ORDER BY us.artifact_path, us.generation, us.id;

-- name: HasPendingUsageDiscovery :one
SELECT CAST(EXISTS (
    SELECT 1
    FROM usage_bindings ub
    JOIN sessions s ON s.id = ub.session_id
    WHERE (s.is_terminated = 0 OR ub.state = 'finalizing')
      AND ub.harness IN ('claude-code', 'codex')
      AND (
          ub.state = 'discovering'
          OR ub.last_error_code = 'source_discovery_pending'
          OR EXISTS (
              SELECT 1
              FROM usage_codex_pending_children pending
              WHERE pending.binding_id = ub.id
          )
          OR EXISTS (
              SELECT 1
              FROM usage_sources source
              WHERE source.binding_id = ub.id
                AND source.state = 'error'
                AND source.last_error_code IN ('artifact_missing', 'source_read_failed')
                AND source.id = (
                    SELECT latest.id
                    FROM usage_sources latest
                    WHERE latest.binding_id = source.binding_id
                      AND latest.artifact_path = source.artifact_path
                    ORDER BY latest.generation DESC, latest.id DESC
                    LIMIT 1
                )
          )
      )
) AS INTEGER);

-- name: ListLatestRetiredCodexReplacementClaimsByPath :many
SELECT us.*
FROM usage_bindings ub
JOIN sessions s ON s.id = ub.session_id
JOIN usage_sources us ON us.id = (
    SELECT latest.id
    FROM usage_sources latest
    WHERE latest.binding_id = ub.id
      AND latest.artifact_path = sqlc.arg(artifact_path)
    ORDER BY latest.generation DESC, latest.id DESC
    LIMIT 1
)
WHERE us.kind = 'codex_rollout'
  AND us.state = 'complete'
  AND us.last_error_code = 'artifact_replaced'
  AND (s.is_terminated = 0 OR ub.state = 'finalizing')
ORDER BY us.binding_id, us.generation, us.id;

-- name: ListUsageDiscoveryBindings :many
SELECT ub.*
FROM usage_bindings ub
JOIN sessions s ON s.id = ub.session_id
WHERE (s.is_terminated = 0 OR ub.state = 'finalizing')
  AND ub.harness IN ('claude-code', 'codex')
  AND (
      ub.state IN ('discovering', 'active', 'finalizing')
      OR (ub.state = 'partial' AND ub.last_error_code = 'codex_source_budget_exceeded')
  )
  AND (
      ub.harness = 'claude-code'
      OR ub.state = 'discovering'
      OR ub.state = 'finalizing'
      OR ub.last_error_code = 'codex_source_budget_exceeded'
      OR ub.last_error_code = 'source_discovery_pending'
      OR NOT EXISTS (
          SELECT 1
          FROM usage_sources us
          WHERE us.binding_id = ub.id
            AND us.kind = 'codex_rollout'
      )
      OR EXISTS (
          SELECT 1
          FROM usage_sources us
          WHERE us.binding_id = ub.id
            AND us.kind = 'codex_rollout'
            AND us.state = 'error'
            AND us.last_error_code IN ('artifact_missing', 'source_read_failed')
      )
	  OR EXISTS (
	      SELECT 1
	      FROM usage_codex_pending_children
	      WHERE binding_id = ub.id
	  )
  )
ORDER BY ub.updated_at, ub.id
LIMIT ?;

-- name: ListUsageBindingsForCodexParent :many
SELECT DISTINCT ub.*
FROM usage_bindings ub
JOIN sessions s ON s.id = ub.session_id
JOIN usage_sources parent ON parent.binding_id = ub.id
WHERE (s.is_terminated = 0 OR ub.state = 'finalizing')
  AND ub.harness = 'codex'
  AND (
      ub.state IN ('discovering', 'active', 'finalizing')
      OR (ub.state = 'partial' AND ub.last_error_code = 'codex_source_budget_exceeded')
  )
  AND parent.kind = 'codex_rollout'
  AND parent.native_session_id = sqlc.arg(parent_native_session_id)
  AND parent.id = (
      SELECT latest.id
      FROM usage_sources latest
      WHERE latest.binding_id = parent.binding_id
        AND latest.kind = 'codex_rollout'
        AND latest.native_session_id = parent.native_session_id
      ORDER BY latest.generation DESC, latest.id DESC
      LIMIT 1
  )
ORDER BY ub.updated_at, ub.id;

-- name: GetUsageSourceWithBindingAndSession :one
SELECT
    us.id AS source_id,
    us.binding_id,
    us.kind,
    us.native_session_id,
    us.subagent_id,
    us.artifact_path,
    us.file_identity,
    us.generation,
    us.byte_offset,
    us.parser_state_json,
    us.state AS source_state,
    us.failure_count,
    us.anomaly_count,
    us.next_retry_at,
    us.last_error_code AS source_last_error_code,
    us.updated_at AS source_updated_at,
    ub.session_id,
    ub.harness,
    ub.native_root_id,
    ub.initial_model_id,
    ub.state AS binding_state
FROM usage_sources us
JOIN usage_bindings ub ON ub.id = us.binding_id
WHERE us.id = ?;

-- name: UpdateUsageSourceCursor :exec
UPDATE usage_sources SET
    byte_offset = ?,
    parser_state_json = ?,
    state = ?,
    failure_count = ?,
    anomaly_count = ?,
    next_retry_at = ?,
    last_error_code = ?,
    updated_at = ?
WHERE id = ?;

-- name: UpdateUsageSourceLifecycle :execrows
UPDATE usage_sources SET
    state = sqlc.arg(state),
    failure_count = COALESCE(sqlc.narg(failure_count), failure_count),
    last_error_code = sqlc.arg(last_error_code),
    next_retry_at = sqlc.narg(next_retry_at),
    updated_at = sqlc.arg(updated_at)
WHERE id = sqlc.arg(id);

-- name: UpdateUsageBinding :execrows
UPDATE usage_bindings SET
    state = CASE
        WHEN sqlc.arg(state) = '' THEN usage_bindings.state
        ELSE sqlc.arg(state)
    END,
    last_error_code = CASE
        WHEN usage_bindings.last_error_code = 'codex_source_budget_exceeded'
        THEN usage_bindings.last_error_code
        ELSE sqlc.arg(last_error_code)
    END,
    updated_at = sqlc.arg(updated_at)
WHERE id = sqlc.arg(id);

-- name: CompleteUsageBindingIfSettled :execrows
UPDATE usage_bindings
SET state = CASE
        WHEN usage_bindings.last_error_code = 'codex_source_budget_exceeded'
          OR EXISTS (
            SELECT 1
            FROM usage_sources
            WHERE usage_sources.binding_id = sqlc.arg(usage_binding_id)
              AND last_error_code <> 'artifact_replaced'
              AND (anomaly_count > 0 OR last_error_code <> '')
        ) THEN 'partial'
        ELSE 'complete'
    END,
    last_error_code = CASE
        WHEN usage_bindings.last_error_code = 'codex_source_budget_exceeded'
        THEN usage_bindings.last_error_code
        ELSE ''
    END,
    updated_at = sqlc.arg(updated_at)
WHERE id = sqlc.arg(usage_binding_id)
  AND state = 'finalizing'
  AND EXISTS (
      SELECT 1
      FROM usage_sources
      WHERE usage_sources.binding_id = sqlc.arg(usage_binding_id)
  )
  AND NOT EXISTS (
      SELECT 1
      FROM usage_sources
      WHERE usage_sources.binding_id = sqlc.arg(usage_binding_id)
        AND state <> 'complete'
	)
	AND (
	    usage_bindings.last_error_code = 'codex_source_budget_exceeded'
	    OR NOT EXISTS (
	        SELECT 1
	        FROM usage_codex_pending_children
	        WHERE binding_id = sqlc.arg(usage_binding_id)
	    )
	)
	AND NOT EXISTS (
	    SELECT 1
	    FROM usage_codex_source_discovery malformed
	    WHERE malformed.binding_id = sqlc.arg(usage_binding_id)
	      AND malformed.source_id = (
	          SELECT latest.id
	          FROM usage_sources latest
	          WHERE latest.binding_id = malformed.binding_id
	            AND latest.kind = 'codex_rollout'
	            AND latest.native_session_id = malformed.native_session_id
	          ORDER BY latest.generation DESC, latest.id DESC
	          LIMIT 1
	      )
	      AND malformed.has_mixed_child_types = 1
  );

-- name: GetModelUsageEventByKey :one
SELECT
    event.id, event.provider_id, event.model_id,
    event.input_tokens, event.input_provenance,
    event.cached_input_tokens, event.cached_input_provenance,
    event.uncached_input_tokens, event.uncached_input_provenance,
    event.output_tokens, event.output_provenance,
    event.created_at,
    openai.openai_reasoning_output_tokens,
    openai.openai_cache_write_input_tokens,
    openai.openai_reported_total_tokens,
    anthropic.anthropic_direct_uncached_input_tokens,
    anthropic.anthropic_cache_creation_input_tokens,
    anthropic.anthropic_cache_creation_5m_input_tokens,
    anthropic.anthropic_cache_creation_1h_input_tokens
FROM model_usage_events event
LEFT JOIN openai_usage_event_details openai ON openai.event_id = event.id
LEFT JOIN anthropic_usage_event_details anthropic ON anthropic.event_id = event.id
WHERE event.binding_id = ? AND event.source_event_key = ?;

-- name: InsertModelUsageEvent :one
INSERT INTO model_usage_events (
    binding_id, usage_source_id, provider_id, model_id,
    input_tokens, input_provenance,
    cached_input_tokens, cached_input_provenance,
    uncached_input_tokens, uncached_input_provenance,
    output_tokens, output_provenance,
    source_event_key, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
RETURNING id;

-- name: UpsertOpenAIUsageEventDetails :execrows
INSERT INTO openai_usage_event_details (
    event_id, openai_reasoning_output_tokens, openai_cache_write_input_tokens,
    openai_reported_total_tokens
) VALUES (?, ?, ?, ?)
ON CONFLICT (event_id) DO UPDATE SET
    openai_reasoning_output_tokens = COALESCE(openai_usage_event_details.openai_reasoning_output_tokens, excluded.openai_reasoning_output_tokens),
    openai_cache_write_input_tokens = COALESCE(openai_usage_event_details.openai_cache_write_input_tokens, excluded.openai_cache_write_input_tokens),
    openai_reported_total_tokens = COALESCE(openai_usage_event_details.openai_reported_total_tokens, excluded.openai_reported_total_tokens)
WHERE (openai_usage_event_details.openai_reasoning_output_tokens IS NULL OR excluded.openai_reasoning_output_tokens IS NULL OR openai_usage_event_details.openai_reasoning_output_tokens = excluded.openai_reasoning_output_tokens)
  AND (openai_usage_event_details.openai_cache_write_input_tokens IS NULL OR excluded.openai_cache_write_input_tokens IS NULL OR openai_usage_event_details.openai_cache_write_input_tokens = excluded.openai_cache_write_input_tokens)
  AND (openai_usage_event_details.openai_reported_total_tokens IS NULL OR excluded.openai_reported_total_tokens IS NULL OR openai_usage_event_details.openai_reported_total_tokens = excluded.openai_reported_total_tokens);

-- name: UpsertAnthropicUsageEventDetails :execrows
INSERT INTO anthropic_usage_event_details (
    event_id, anthropic_direct_uncached_input_tokens,
    anthropic_cache_creation_input_tokens,
    anthropic_cache_creation_5m_input_tokens,
    anthropic_cache_creation_1h_input_tokens
) VALUES (?, ?, ?, ?, ?)
ON CONFLICT (event_id) DO UPDATE SET
    anthropic_direct_uncached_input_tokens = COALESCE(anthropic_usage_event_details.anthropic_direct_uncached_input_tokens, excluded.anthropic_direct_uncached_input_tokens),
    anthropic_cache_creation_input_tokens = COALESCE(anthropic_usage_event_details.anthropic_cache_creation_input_tokens, excluded.anthropic_cache_creation_input_tokens),
    anthropic_cache_creation_5m_input_tokens = COALESCE(anthropic_usage_event_details.anthropic_cache_creation_5m_input_tokens, excluded.anthropic_cache_creation_5m_input_tokens),
    anthropic_cache_creation_1h_input_tokens = COALESCE(anthropic_usage_event_details.anthropic_cache_creation_1h_input_tokens, excluded.anthropic_cache_creation_1h_input_tokens)
WHERE (anthropic_usage_event_details.anthropic_direct_uncached_input_tokens IS NULL OR excluded.anthropic_direct_uncached_input_tokens IS NULL OR anthropic_usage_event_details.anthropic_direct_uncached_input_tokens = excluded.anthropic_direct_uncached_input_tokens)
  AND (anthropic_usage_event_details.anthropic_cache_creation_input_tokens IS NULL OR excluded.anthropic_cache_creation_input_tokens IS NULL OR anthropic_usage_event_details.anthropic_cache_creation_input_tokens = excluded.anthropic_cache_creation_input_tokens)
  AND (anthropic_usage_event_details.anthropic_cache_creation_5m_input_tokens IS NULL OR excluded.anthropic_cache_creation_5m_input_tokens IS NULL OR anthropic_usage_event_details.anthropic_cache_creation_5m_input_tokens = excluded.anthropic_cache_creation_5m_input_tokens)
  AND (anthropic_usage_event_details.anthropic_cache_creation_1h_input_tokens IS NULL OR excluded.anthropic_cache_creation_1h_input_tokens IS NULL OR anthropic_usage_event_details.anthropic_cache_creation_1h_input_tokens = excluded.anthropic_cache_creation_1h_input_tokens);

-- name: TouchUsageBinding :exec
UPDATE usage_bindings SET updated_at = ? WHERE id = ?;

-- name: AggregateUsageBySessionHarnessModel :many
SELECT
    ub.harness,
    mue.model_id,
    COUNT(*) AS event_count,
    CAST(COALESCE(SUM(mue.input_tokens), 0) AS INTEGER) AS input_tokens,
    CAST(CASE WHEN COUNT(mue.input_tokens) <> COUNT(*) THEN 'unknown'
         WHEN COUNT(DISTINCT mue.input_provenance) = 1 THEN MIN(mue.input_provenance)
         ELSE 'derived' END AS TEXT) AS input_provenance,
    CAST(COALESCE(SUM(mue.cached_input_tokens), 0) AS INTEGER) AS cached_input_tokens,
    CAST(CASE WHEN COUNT(mue.cached_input_tokens) <> COUNT(*) THEN 'unknown'
         WHEN COUNT(DISTINCT mue.cached_input_provenance) = 1 THEN MIN(mue.cached_input_provenance)
         ELSE 'derived' END AS TEXT) AS cached_input_provenance,
    CAST(COALESCE(SUM(mue.uncached_input_tokens), 0) AS INTEGER) AS uncached_input_tokens,
    CAST(CASE WHEN COUNT(mue.uncached_input_tokens) <> COUNT(*) THEN 'unknown'
         WHEN COUNT(DISTINCT mue.uncached_input_provenance) = 1 THEN MIN(mue.uncached_input_provenance)
         ELSE 'derived' END AS TEXT) AS uncached_input_provenance,
    CAST(COALESCE(SUM(mue.output_tokens), 0) AS INTEGER) AS output_tokens,
    CAST(CASE WHEN COUNT(mue.output_tokens) <> COUNT(*) THEN 'unknown'
         WHEN COUNT(DISTINCT mue.output_provenance) = 1 THEN MIN(mue.output_provenance)
         ELSE 'derived' END AS TEXT) AS output_provenance,
    COUNT(CASE WHEN mue.provider_id = 'openai' THEN 1 END) AS openai_event_count,
    CAST(COALESCE(SUM(openai.openai_reasoning_output_tokens), 0) AS INTEGER) AS openai_reasoning_output_tokens,
    COUNT(openai.openai_reasoning_output_tokens) AS openai_reasoning_output_event_count,
    CAST(COALESCE(SUM(openai.openai_cache_write_input_tokens), 0) AS INTEGER) AS openai_cache_write_input_tokens,
    COUNT(openai.openai_cache_write_input_tokens) AS openai_cache_write_input_event_count,
    COUNT(CASE WHEN mue.provider_id = 'anthropic' THEN 1 END) AS anthropic_event_count,
    CAST(COALESCE(SUM(anthropic.anthropic_direct_uncached_input_tokens), 0) AS INTEGER) AS anthropic_direct_uncached_input_tokens,
    COUNT(anthropic.anthropic_direct_uncached_input_tokens) AS anthropic_direct_uncached_input_event_count,
    CAST(COALESCE(SUM(anthropic.anthropic_cache_creation_input_tokens), 0) AS INTEGER) AS anthropic_cache_creation_input_tokens,
    COUNT(anthropic.anthropic_cache_creation_input_tokens) AS anthropic_cache_creation_input_event_count,
    CAST(COALESCE(SUM(anthropic.anthropic_cache_creation_5m_input_tokens), 0) AS INTEGER) AS anthropic_cache_creation_5m_input_tokens,
    COUNT(anthropic.anthropic_cache_creation_5m_input_tokens) AS anthropic_cache_creation_5m_input_event_count,
    CAST(COALESCE(SUM(anthropic.anthropic_cache_creation_1h_input_tokens), 0) AS INTEGER) AS anthropic_cache_creation_1h_input_tokens,
    COUNT(anthropic.anthropic_cache_creation_1h_input_tokens) AS anthropic_cache_creation_1h_input_event_count
FROM model_usage_events mue
JOIN usage_bindings ub ON ub.id = mue.binding_id
LEFT JOIN openai_usage_event_details openai ON openai.event_id = mue.id
LEFT JOIN anthropic_usage_event_details anthropic ON anthropic.event_id = mue.id
WHERE ub.session_id = ?
GROUP BY ub.harness, mue.model_id
ORDER BY SUM(mue.input_tokens + mue.output_tokens) DESC, ub.harness, mue.model_id;

-- name: GetUsageSessionIncomplete :one
SELECT CAST(COALESCE((
    SELECT incomplete FROM usage_session_integrity WHERE session_id = ?
), 0) AS INTEGER);

-- name: ListCompactSessionUsage :many
SELECT
    ub.session_id,
    CAST(COALESCE(SUM(mue.input_tokens) + SUM(mue.output_tokens), 0) AS INTEGER) AS processed_tokens,
    CAST(COUNT(mue.input_tokens) = COUNT(*) AND COUNT(mue.output_tokens) = COUNT(*) AS INTEGER) AS processed_tokens_known,
    CAST(COALESCE(integrity.incomplete, 0) AS INTEGER) AS incomplete
FROM model_usage_events mue
JOIN usage_bindings ub ON ub.id = mue.binding_id
JOIN sessions s ON s.id = ub.session_id
LEFT JOIN usage_session_integrity integrity ON integrity.session_id = ub.session_id
WHERE (sqlc.arg(project_id) = '' OR s.project_id = sqlc.arg(project_id))
GROUP BY ub.session_id
ORDER BY s.project_id, s.num;
