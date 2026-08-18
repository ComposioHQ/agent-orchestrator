-- name: ProjectControlProjectExists :one
SELECT EXISTS(SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL);

-- name: GetProjectControlHead :one
SELECT project_id, root_outcome_id, revision, owner_role
FROM project_control_heads WHERE project_id = ?;

-- name: GetProjectControlOutcome :one
SELECT id, project_id, statement
FROM project_control_outcomes WHERE id = ?;

-- name: ListProjectControlCriteria :many
SELECT id, outcome_id, statement, verification_method, display_order
FROM project_control_acceptance_criteria
WHERE outcome_id = ? ORDER BY display_order, id;

-- name: GetProjectControlSetResult :one
SELECT project_id, idempotency_key, request_fingerprint, revision, result_json
FROM project_control_set_results
WHERE project_id = ? AND idempotency_key = ?;

-- name: GetProjectControlCriterion :one
SELECT id, outcome_id, statement, verification_method, display_order
FROM project_control_acceptance_criteria WHERE id = ?;

-- name: InsertProjectControlHead :exec
INSERT INTO project_control_heads (project_id, root_outcome_id, revision, owner_role)
VALUES (?, ?, ?, ?);

-- name: UpdateProjectControlHeadRevision :execrows
UPDATE project_control_heads SET revision = ?
WHERE project_id = ? AND revision = ?;

-- name: InsertProjectControlOutcome :exec
INSERT INTO project_control_outcomes (id, project_id, statement) VALUES (?, ?, ?);

-- name: UpdateProjectControlOutcome :execrows
UPDATE project_control_outcomes SET statement = ? WHERE id = ? AND project_id = ?;

-- name: UpsertProjectControlCriterion :exec
INSERT INTO project_control_acceptance_criteria (id, outcome_id, statement, verification_method, display_order)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT (id) DO UPDATE SET
    statement = excluded.statement,
    verification_method = excluded.verification_method,
    display_order = excluded.display_order;

-- name: DeleteProjectControlCriteriaForOutcome :exec
DELETE FROM project_control_acceptance_criteria WHERE outcome_id = ?;

-- name: InsertProjectControlSetResult :exec
INSERT INTO project_control_set_results
    (project_id, idempotency_key, request_fingerprint, revision, result_json)
VALUES (?, ?, ?, ?, ?);

-- name: InsertProjectControlEvent :exec
INSERT INTO project_control_events
    (project_id, outcome_id, revision, event_type, payload, created_at)
VALUES (?, ?, ?, 'outcome.set', ?, ?);
