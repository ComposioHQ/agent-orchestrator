package postgres

import (
	"context"
	"errors"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
	"github.com/jackc/pgx/v5"
)

func (s *Store) ListOrchestratorChildren(
	ctx context.Context,
	orgID, orchestratorSessionID string,
	cursor *domain.Cursor,
	limit int,
) ([]domain.Session, bool, error) {
	var sessions []domain.Session
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		if _, err := requireActiveOrchestrator(ctx, tx, orgID, orchestratorSessionID); err != nil {
			return err
		}
		rows, err := tx.Query(
			ctx,
			sessionSelect+`
			WHERE session.org_id = $1
			  AND session.parent_session_id = $2
			  AND ($3::timestamptz IS NULL OR (session.updated_at, session.id) < ($3, $4::uuid))
			ORDER BY session.updated_at DESC, session.id DESC
			LIMIT $5`,
			orgID, orchestratorSessionID, cursorTime(cursor), cursorID(cursor), limit+1,
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

func (s *Store) CreateOrchestratorChild(
	ctx context.Context,
	orgID, orchestratorSessionID, idempotencyKey string,
	input domain.CreateSession,
) (domain.Session, error) {
	var child domain.Session
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		projectID, err := requireActiveOrchestrator(ctx, tx, orgID, orchestratorSessionID)
		if err != nil {
			return err
		}
		input.ProjectID = projectID
		input.Kind = "worker"
		child, err = createSessionTx(
			ctx, tx, orgID, idempotencyKey, input, orchestratorSessionID, "",
		)
		return err
	})
	return child, err
}

func (s *Store) SendOrchestratorChildMessage(
	ctx context.Context,
	orgID, orchestratorSessionID, childSessionID, idempotencyKey, text string,
) (domain.ClientEvent, error) {
	var event domain.ClientEvent
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		projectID, err := requireActiveOrchestrator(ctx, tx, orgID, orchestratorSessionID)
		if err != nil {
			return err
		}
		var allowed bool
		if err := tx.QueryRow(
			ctx,
			`SELECT EXISTS (
				SELECT 1 FROM ao_sessions
				WHERE org_id = $1
				  AND id = $2
				  AND project_id = $3
				  AND parent_session_id = $4
			)`,
			orgID, childSessionID, projectID, orchestratorSessionID,
		).Scan(&allowed); err != nil {
			return err
		}
		if !allowed {
			return ErrForbidden
		}
		event, err = sendMessageTx(
			ctx, tx, orgID, childSessionID, idempotencyKey, text, "", orchestratorSessionID,
		)
		return err
	})
	return event, err
}

func (s *Store) CountOrchestratorSandboxes(
	ctx context.Context,
	orgID, orchestratorSessionID string,
) (int, error) {
	var count int
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		if _, err := requireActiveOrchestrator(ctx, tx, orgID, orchestratorSessionID); err != nil {
			return err
		}
		return tx.QueryRow(
			ctx,
			`SELECT count(*) FROM ao_sandboxes
			WHERE org_id = $1 AND desired_state <> 'deleted'`,
			orgID,
		).Scan(&count)
	})
	return count, err
}

func requireActiveOrchestrator(
	ctx context.Context,
	tx pgx.Tx,
	orgID, sessionID string,
) (string, error) {
	var projectID string
	err := tx.QueryRow(
		ctx,
		`SELECT project_id
		FROM ao_sessions
		WHERE org_id = $1 AND id = $2
		  AND kind = 'orchestrator' AND is_terminated = false`,
		orgID, sessionID,
	).Scan(&projectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrForbidden
	}
	return projectID, err
}
