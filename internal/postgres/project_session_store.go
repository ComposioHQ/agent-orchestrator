package postgres

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/pkg/contract"
	"github.com/jackc/pgx/v5"
)

func (s *Store) CreateProject(
	ctx context.Context,
	principal domain.Principal,
	orgID string,
	idempotencyKey string,
	input domain.CreateProject,
) (domain.Project, error) {
	var project domain.Project
	err := s.withTenant(ctx, principal, orgID, func(tx pgx.Tx) error {
		payload, err := json.Marshal(input)
		if err != nil {
			return err
		}
		var commandID string
		err = tx.QueryRow(
			ctx,
			`INSERT INTO ao_commands (
				org_id, idempotency_key, kind, payload
			) VALUES ($1, $2, 'project.create', $3)
			ON CONFLICT (org_id, idempotency_key) DO NOTHING
			RETURNING id`,
			orgID,
			idempotencyKey,
			payload,
		).Scan(&commandID)
		if errors.Is(err, pgx.ErrNoRows) {
			return loadIdempotentProject(
				ctx,
				tx,
				orgID,
				idempotencyKey,
				payload,
				&project,
			)
		}
		if err != nil {
			return err
		}

		config := input.Config
		if len(config) == 0 {
			config = json.RawMessage(`{}`)
		}
		err = scanProject(tx.QueryRow(
			ctx,
			`INSERT INTO ao_projects (
				org_id, display_name, repository_url, default_branch, config
			) VALUES ($1, $2, $3, $4, $5)
			RETURNING id, org_id, display_name, repository_url, default_branch,
				config, created_at, updated_at`,
			orgID,
			input.DisplayName,
			input.RepositoryURL,
			input.DefaultBranch,
			config,
		), &project)
		if err != nil {
			return normalizeConstraintError(err)
		}
		if _, err := tx.Exec(
			ctx,
			`UPDATE ao_commands
			SET status = 'succeeded',
				result = jsonb_build_object('projectId', $1::text),
				updated_at = now()
			WHERE id = $2`,
			project.ID,
			commandID,
		); err != nil {
			return err
		}
		_, err = tx.Exec(
			ctx,
			`INSERT INTO ao_audit_events (
				org_id, actor_user_id, action, resource_type, resource_id
			) VALUES ($1, $2, 'project.created', 'project', $3)`,
			orgID,
			principal.UserID,
			project.ID,
		)
		return err
	})
	return project, err
}

func loadIdempotentProject(
	ctx context.Context,
	tx pgx.Tx,
	orgID string,
	idempotencyKey string,
	payload []byte,
	project *domain.Project,
) error {
	var storedPayload []byte
	var projectID string
	var kind, status string
	err := tx.QueryRow(
		ctx,
		`SELECT kind, status, payload, result->>'projectId'
		FROM ao_commands
		WHERE org_id = $1 AND idempotency_key = $2`,
		orgID,
		idempotencyKey,
	).Scan(&kind, &status, &storedPayload, &projectID)
	if err != nil {
		return err
	}
	if kind != "project.create" || status != "succeeded" ||
		!jsonEqual(storedPayload, payload) || projectID == "" {
		return ErrIdempotencyMismatch
	}
	return scanProject(tx.QueryRow(
		ctx,
		`SELECT id, org_id, display_name, repository_url, default_branch,
			config, created_at, updated_at
		FROM ao_projects WHERE org_id = $1 AND id = $2`,
		orgID,
		projectID,
	), project)
}

func (s *Store) ListProjects(
	ctx context.Context,
	principal domain.Principal,
	orgID string,
	cursor *domain.Cursor,
	limit int,
) ([]domain.Project, bool, error) {
	var projects []domain.Project
	err := s.withTenant(ctx, principal, orgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(
			ctx,
			`SELECT id, org_id, display_name, repository_url, default_branch,
				config, created_at, updated_at
			FROM ao_projects
			WHERE org_id = $1
			  AND ($2::timestamptz IS NULL OR (created_at, id) < ($2, $3::uuid))
			ORDER BY created_at DESC, id DESC
			LIMIT $4`,
			orgID,
			cursorTime(cursor),
			cursorID(cursor),
			limit+1,
		)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var project domain.Project
			if err := scanProject(rows, &project); err != nil {
				return err
			}
			projects = append(projects, project)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, false, err
	}
	hasMore := len(projects) > limit
	if hasMore {
		projects = projects[:limit]
	}
	return projects, hasMore, nil
}

func (s *Store) CreateSession(
	ctx context.Context,
	principal domain.Principal,
	orgID string,
	idempotencyKey string,
	input domain.CreateSession,
) (domain.Session, error) {
	var session domain.Session
	err := s.withTenant(ctx, principal, orgID, func(tx pgx.Tx) error {
		payload, err := json.Marshal(input)
		if err != nil {
			return err
		}
		var commandID string
		err = tx.QueryRow(
			ctx,
			`INSERT INTO ao_commands (
				org_id, idempotency_key, kind, payload
			) VALUES ($1, $2, 'session.create', $3)
			ON CONFLICT (org_id, idempotency_key) DO NOTHING
			RETURNING id`,
			orgID,
			idempotencyKey,
			payload,
		).Scan(&commandID)
		if errors.Is(err, pgx.ErrNoRows) {
			return loadIdempotentSession(
				ctx,
				tx,
				orgID,
				idempotencyKey,
				payload,
				&session,
			)
		}
		if err != nil {
			return err
		}

		err = scanSession(tx.QueryRow(
			ctx,
			`WITH generated AS (SELECT gen_random_uuid() AS id)
			INSERT INTO ao_sessions (
				id, org_id, project_id, kind, harness, display_name, branch, prompt
			)
			SELECT id, $1, $2, $3, $4, $5, 'ao/' || left(id::text, 8), $6
			FROM generated
			RETURNING id, org_id, project_id, kind, harness, display_name, branch,
				activity_state, is_terminated, false, '', '', created_at, updated_at`,
			orgID,
			input.ProjectID,
			input.Kind,
			input.Harness,
			input.DisplayName,
			input.Prompt,
		), &session)
		if err != nil {
			return normalizeConstraintError(err)
		}

		if input.ProviderConnectionID != "" {
			var provider string
			if err := tx.QueryRow(
				ctx,
				`SELECT provider FROM ao_provider_connections
				WHERE org_id = $1 AND id = $2`,
				orgID,
				input.ProviderConnectionID,
			).Scan(&provider); errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			} else if err != nil {
				return err
			}
			if _, err := tx.Exec(
				ctx,
				`INSERT INTO ao_sandboxes (
					session_id, org_id, provider, provider_connection_id
				) VALUES ($1, $2, $3, $4)`,
				session.ID,
				orgID,
				provider,
				input.ProviderConnectionID,
			); err != nil {
				return err
			}
			session.RuntimeState = "requested"
		}

		if _, err := tx.Exec(
			ctx,
			`UPDATE ao_commands
			SET session_id = $1,
				status = 'succeeded',
				result = jsonb_build_object('sessionId', $2::text),
				updated_at = now()
			WHERE id = $3`,
			session.ID,
			session.ID,
			commandID,
		); err != nil {
			return err
		}
		_, err = tx.Exec(
			ctx,
			`INSERT INTO ao_audit_events (
				org_id, actor_user_id, action, resource_type, resource_id
			) VALUES ($1, $2, 'session.created', 'session', $3)`,
			orgID,
			principal.UserID,
			session.ID,
		)
		return err
	})
	return session, err
}

func loadIdempotentSession(
	ctx context.Context,
	tx pgx.Tx,
	orgID string,
	idempotencyKey string,
	payload []byte,
	session *domain.Session,
) error {
	var storedPayload []byte
	var sessionID string
	var kind, status string
	err := tx.QueryRow(
		ctx,
		`SELECT kind, status, payload, result->>'sessionId'
		FROM ao_commands
		WHERE org_id = $1 AND idempotency_key = $2`,
		orgID,
		idempotencyKey,
	).Scan(&kind, &status, &storedPayload, &sessionID)
	if err != nil {
		return err
	}
	if kind != "session.create" || status != "succeeded" ||
		!jsonEqual(storedPayload, payload) || sessionID == "" {
		return ErrIdempotencyMismatch
	}
	return getSession(ctx, tx, orgID, sessionID, session)
}

func (s *Store) ListSessions(
	ctx context.Context,
	principal domain.Principal,
	orgID string,
	projectID string,
	cursor *domain.Cursor,
	limit int,
) ([]domain.Session, bool, error) {
	var sessions []domain.Session
	err := s.withTenant(ctx, principal, orgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(
			ctx,
			sessionSelect+`
			WHERE session.org_id = $1
			  AND ($2 = '' OR session.project_id = $2::uuid)
			  AND ($3::timestamptz IS NULL OR (session.updated_at, session.id) < ($3, $4::uuid))
			ORDER BY session.updated_at DESC, session.id DESC
			LIMIT $5`,
			orgID,
			projectID,
			cursorTime(cursor),
			cursorID(cursor),
			limit+1,
		)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var session domain.Session
			if err := scanSession(rows, &session); err != nil {
				return err
			}
			sessions = append(sessions, session)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, false, err
	}
	hasMore := len(sessions) > limit
	if hasMore {
		sessions = sessions[:limit]
	}
	return sessions, hasMore, nil
}

func (s *Store) GetSession(
	ctx context.Context,
	principal domain.Principal,
	orgID string,
	sessionID string,
) (domain.Session, error) {
	var session domain.Session
	err := s.withTenant(ctx, principal, orgID, func(tx pgx.Tx) error {
		return getSession(ctx, tx, orgID, sessionID, &session)
	})
	return session, err
}

const sessionSelect = `
	SELECT session.id, session.org_id, session.project_id, session.kind,
		session.harness, session.display_name, session.branch,
		session.activity_state, session.is_terminated,
		EXISTS (
			SELECT 1 FROM ao_worker_connections worker
			WHERE worker.session_id = session.id AND worker.disconnected_at IS NULL
		),
		COALESCE(sandbox.observed_state, ''),
		COALESCE(sandbox.last_error, ''),
		session.created_at, session.updated_at
	FROM ao_sessions session
	LEFT JOIN ao_sandboxes sandbox
		ON sandbox.org_id = session.org_id AND sandbox.session_id = session.id
`

func getSession(
	ctx context.Context,
	tx pgx.Tx,
	orgID string,
	sessionID string,
	session *domain.Session,
) error {
	err := scanSession(tx.QueryRow(
		ctx,
		sessionSelect+` WHERE session.org_id = $1 AND session.id = $2`,
		orgID,
		sessionID,
	), session)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

type scanner interface {
	Scan(dest ...any) error
}

func scanProject(row scanner, project *domain.Project) error {
	return row.Scan(
		&project.ID,
		&project.OrgID,
		&project.DisplayName,
		&project.RepositoryURL,
		&project.DefaultBranch,
		&project.Config,
		&project.CreatedAt,
		&project.UpdatedAt,
	)
}

func scanSession(row scanner, session *domain.Session) error {
	var activity string
	err := row.Scan(
		&session.ID,
		&session.OrgID,
		&session.ProjectID,
		&session.Kind,
		&session.Harness,
		&session.DisplayName,
		&session.Branch,
		&activity,
		&session.IsTerminated,
		&session.RuntimeConnected,
		&session.RuntimeState,
		&session.RuntimeError,
		&session.CreatedAt,
		&session.UpdatedAt,
	)
	session.ActivityState = contract.ActivityState(activity)
	return err
}

func jsonEqual(left, right []byte) bool {
	var leftValue, rightValue any
	if json.Unmarshal(left, &leftValue) != nil || json.Unmarshal(right, &rightValue) != nil {
		return bytes.Equal(left, right)
	}
	leftJSON, _ := json.Marshal(leftValue)
	rightJSON, _ := json.Marshal(rightValue)
	return bytes.Equal(leftJSON, rightJSON)
}

func cursorTime(cursor *domain.Cursor) any {
	if cursor == nil {
		return nil
	}
	return cursor.Time
}

func cursorID(cursor *domain.Cursor) any {
	if cursor == nil {
		return nil
	}
	return cursor.ID
}
