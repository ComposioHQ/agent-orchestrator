package postgres

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

const maxWorkspacePlacementPage = 100

type workspacePlacementCursor struct {
	CreatedAt time.Time `json:"createdAt"`
	ID        string    `json:"id"`
}

// CreateWorkspacePlacement durably accepts an idempotent provision intent.
// created is false for an exact replay. Reusing a key with different immutable
// input returns ErrConflict.
func (s *Store) CreateWorkspacePlacement(ctx context.Context, input domain.CreateWorkspacePlacement) (placement domain.WorkspacePlacement, created bool, err error) {
	input.IdempotencyKey = strings.TrimSpace(input.IdempotencyKey)
	if input.IdempotencyKey == "" || len(input.IdempotencyKey) > 200 {
		return placement, false, ErrInvalid
	}
	config, err := canonicalPlacementConfig(input.Config)
	if err != nil {
		return placement, false, err
	}
	err = s.withTenantTx(ctx, pgx.TxOptions{}, func(tx pgx.Tx, identity tenant.Identity) error {
		id := uuid.NewString()
		tag, execErr := tx.Exec(ctx,
			`INSERT INTO ao_cloud_workspaces
			    (id, org_id, owner_user_id, display_name, repository_url,
			     repository_ref, config, state, error, intent, idempotency_key)
			 VALUES ($1, $2, $3, $4, $5, $6, NULLIF($7, '')::jsonb,
			         'pending', '', 'provision', $8)
			 ON CONFLICT (org_id, owner_user_id, idempotency_key)
			     WHERE idempotency_key IS NOT NULL DO NOTHING`,
			id, identity.OrgID, identity.UserID, strings.TrimSpace(input.DisplayName),
			strings.TrimSpace(input.RepositoryURL), strings.TrimSpace(input.DefaultBranch),
			string(config), input.IdempotencyKey)
		if execErr != nil {
			return fmt.Errorf("create workspace placement: %w", normalizeError(execErr))
		}
		created = tag.RowsAffected() == 1
		row := tx.QueryRow(ctx, workspacePlacementSelect+`
			 WHERE org_id = $1 AND owner_user_id = $2 AND idempotency_key = $3`,
			identity.OrgID, identity.UserID, input.IdempotencyKey)
		if scanErr := scanWorkspacePlacement(row, &placement); scanErr != nil {
			return fmt.Errorf("read created workspace placement: %w", normalizeError(scanErr))
		}
		if !created && (placement.DisplayName != strings.TrimSpace(input.DisplayName) ||
			placement.RepositoryURL != strings.TrimSpace(input.RepositoryURL) ||
			placement.DefaultBranch != strings.TrimSpace(input.DefaultBranch) ||
			!jsonEqual(placement.Config, config)) {
			return fmt.Errorf("%w: idempotency key was already used for different placement input", ErrConflict)
		}
		return nil
	})
	return placement, created, err
}

// GetWorkspacePlacement loads one placement owned by the acting tenant.
func (s *Store) GetWorkspacePlacement(ctx context.Context, id string) (placement domain.WorkspacePlacement, err error) {
	err = s.withTenantTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx pgx.Tx, identity tenant.Identity) error {
		return normalizeError(scanWorkspacePlacement(tx.QueryRow(ctx, workspacePlacementSelect+`
			 WHERE org_id = $1 AND owner_user_id = $2 AND id = $3`, identity.OrgID, identity.UserID, id), &placement))
	})
	return placement, err
}

// ListWorkspacePlacements returns a stable newest-first page.
func (s *Store) ListWorkspacePlacements(ctx context.Context, cursor string, limit int) (page domain.WorkspacePlacementPage, err error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > maxWorkspacePlacementPage {
		return page, ErrInvalid
	}
	decoded, err := decodeWorkspacePlacementCursor(cursor)
	if err != nil {
		return page, err
	}
	err = s.withTenantTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx pgx.Tx, identity tenant.Identity) error {
		rows, queryErr := tx.Query(ctx, workspacePlacementSelect+`
			 WHERE org_id = $1 AND owner_user_id = $2
			   AND ($3::timestamptz IS NULL OR (created_at, id) < ($3, $4::uuid))
			 ORDER BY created_at DESC, id DESC LIMIT $5`, identity.OrgID, identity.UserID,
			nullPlacementTime(decoded.CreatedAt), nullPlacementString(decoded.ID), limit+1)
		if queryErr != nil {
			return fmt.Errorf("list workspace placements: %w", normalizeError(queryErr))
		}
		defer rows.Close()
		page.Workspaces = make([]domain.WorkspacePlacement, 0, limit)
		for rows.Next() {
			var placement domain.WorkspacePlacement
			if scanErr := scanWorkspacePlacement(rows, &placement); scanErr != nil {
				return fmt.Errorf("scan workspace placement: %w", normalizeError(scanErr))
			}
			page.Workspaces = append(page.Workspaces, placement)
		}
		if rows.Err() != nil {
			return rows.Err()
		}
		if len(page.Workspaces) > limit {
			page.HasMore = true
			page.Workspaces = page.Workspaces[:limit]
			last := page.Workspaces[len(page.Workspaces)-1]
			page.NextCursor = encodeWorkspacePlacementCursor(last.CreatedAt, last.ID)
		}
		return nil
	})
	return page, err
}

// RequestWorkspacePlacementDelete durably changes the desired operation. An
// exact retry is a no-op; a resume cannot race a delete intent.
func (s *Store) RequestWorkspacePlacementDelete(ctx context.Context, id, idempotencyKey string) (domain.WorkspacePlacement, bool, error) {
	return s.requestWorkspacePlacementIntent(ctx, id, idempotencyKey, domain.WorkspacePlacementDelete)
}

// RequestWorkspacePlacementResume durably changes the desired operation.
func (s *Store) RequestWorkspacePlacementResume(ctx context.Context, id, idempotencyKey string) (domain.WorkspacePlacement, bool, error) {
	return s.requestWorkspacePlacementIntent(ctx, id, idempotencyKey, domain.WorkspacePlacementResume)
}

func (s *Store) requestWorkspacePlacementIntent(ctx context.Context, id, idempotencyKey string, intent domain.WorkspacePlacementIntent) (placement domain.WorkspacePlacement, changed bool, err error) {
	idempotencyKey = strings.TrimSpace(idempotencyKey)
	if idempotencyKey == "" || len(idempotencyKey) > 200 {
		return placement, false, ErrInvalid
	}
	err = s.withTenantTx(ctx, pgx.TxOptions{}, func(tx pgx.Tx, identity tenant.Identity) error {
		if scanErr := scanWorkspacePlacement(tx.QueryRow(ctx, workspacePlacementSelect+`
			 WHERE org_id = $1 AND owner_user_id = $2 AND id = $3 FOR UPDATE`, identity.OrgID, identity.UserID, id), &placement); scanErr != nil {
			return normalizeError(scanErr)
		}
		if placement.MutationIdempotencyKey == idempotencyKey {
			if placement.MutationIntent != intent {
				return fmt.Errorf("%w: idempotency key was already used for a different workspace operation", ErrConflict)
			}
			return nil // replay, including after the original mutation completed
		}
		if placement.Intent == domain.WorkspacePlacementDelete && intent != domain.WorkspacePlacementDelete {
			return fmt.Errorf("%w: workspace deletion is already pending", ErrConflict)
		}
		if _, execErr := tx.Exec(ctx, `UPDATE ao_cloud_workspaces
			SET intent = $4, state = 'pending', error = '',
			    mutation_idempotency_key = $5, mutation_intent = $4,
			    updated_at = now()
			WHERE org_id = $1 AND owner_user_id = $2 AND id = $3`,
			identity.OrgID, identity.UserID, id, string(intent), idempotencyKey); execErr != nil {
			return normalizeError(execErr)
		}
		changed = true
		return scanWorkspacePlacement(tx.QueryRow(ctx, workspacePlacementSelect+`
			 WHERE org_id = $1 AND owner_user_id = $2 AND id = $3`, identity.OrgID, identity.UserID, id), &placement)
	})
	return placement, changed, err
}

// CompleteWorkspacePlacement is the provider-neutral executor callback. For a
// provision it links the created project; resume may leave projectID empty.
func (s *Store) CompleteWorkspacePlacement(ctx context.Context, id, projectID, message string) (placement domain.WorkspacePlacement, err error) {
	err = s.withTenantTx(ctx, pgx.TxOptions{}, func(tx pgx.Tx, identity tenant.Identity) error {
		return normalizeError(scanWorkspacePlacement(tx.QueryRow(ctx, `UPDATE ao_cloud_workspaces
			SET state = 'ready', project_id = COALESCE(NULLIF($4, ''), project_id),
			    error = $5, updated_at = now()
			WHERE org_id = $1 AND owner_user_id = $2 AND id = $3
			RETURNING `+workspacePlacementColumns, identity.OrgID, identity.UserID, id,
			strings.TrimSpace(projectID), strings.TrimSpace(message)), &placement))
	})
	return placement, err
}

// FailWorkspacePlacement records a terminal failure without losing its intent,
// allowing a later explicit resume to retry it.
func (s *Store) FailWorkspacePlacement(ctx context.Context, id, message string) (placement domain.WorkspacePlacement, err error) {
	err = s.withTenantTx(ctx, pgx.TxOptions{}, func(tx pgx.Tx, identity tenant.Identity) error {
		return normalizeError(scanWorkspacePlacement(tx.QueryRow(ctx, `UPDATE ao_cloud_workspaces
			SET state = 'failed', error = $4, updated_at = now()
			WHERE org_id = $1 AND owner_user_id = $2 AND id = $3
			RETURNING `+workspacePlacementColumns, identity.OrgID, identity.UserID, id,
			strings.TrimSpace(message)), &placement))
	})
	return placement, err
}

// RemoveWorkspacePlacement completes a delete intent after the executor has
// torn down provider resources. It is idempotent when the row is already gone.
func (s *Store) RemoveWorkspacePlacement(ctx context.Context, id string) error {
	return s.withTenantTx(ctx, pgx.TxOptions{}, func(tx pgx.Tx, identity tenant.Identity) error {
		_, err := tx.Exec(ctx, `DELETE FROM ao_cloud_workspaces
			WHERE org_id = $1 AND owner_user_id = $2 AND id = $3 AND intent = 'delete'`,
			identity.OrgID, identity.UserID, id)
		return normalizeError(err)
	})
}

const workspacePlacementColumns = `id, org_id, owner_user_id, display_name,
	repository_url, repository_ref, config, intent, state, project_id, error,
	idempotency_key, mutation_idempotency_key, mutation_intent, created_at, updated_at`

const workspacePlacementSelect = `SELECT ` + workspacePlacementColumns + ` FROM ao_cloud_workspaces`

type placementRowScanner interface{ Scan(...any) error }

func scanWorkspacePlacement(row placementRowScanner, placement *domain.WorkspacePlacement) error {
	var config []byte
	var projectID, idempotencyKey, mutationKey, mutationIntent *string
	var persistedState string
	if err := row.Scan(&placement.ID, &placement.OrgID, &placement.OwnerUserID,
		&placement.DisplayName, &placement.RepositoryURL, &placement.DefaultBranch,
		&config, &placement.Intent, &persistedState, &projectID, &placement.Message,
		&idempotencyKey, &mutationKey, &mutationIntent, &placement.CreatedAt, &placement.UpdatedAt); err != nil {
		return err
	}
	placement.Config = config
	if projectID != nil {
		placement.ProjectID = *projectID
	}
	if idempotencyKey != nil {
		placement.IdempotencyKey = *idempotencyKey
	}
	if mutationKey != nil {
		placement.MutationIdempotencyKey = *mutationKey
	}
	if mutationIntent != nil {
		placement.MutationIntent = domain.WorkspacePlacementIntent(*mutationIntent)
	}
	if persistedState == "ready" {
		placement.State = domain.WorkspacePlacementReady
	} else if persistedState == "failed" {
		placement.State = domain.WorkspacePlacementFailed
	} else {
		placement.State = domain.WorkspacePlacementPending
	}
	return nil
}

func canonicalPlacementConfig(raw json.RawMessage) (json.RawMessage, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var object map[string]any
	if err := json.Unmarshal(raw, &object); err != nil || object == nil {
		return nil, ErrInvalid
	}
	canonical, err := json.Marshal(object)
	if err != nil {
		return nil, ErrInvalid
	}
	return canonical, nil
}

func jsonEqual(left, right json.RawMessage) bool {
	var l, r any
	if len(left) == 0 && len(right) == 0 {
		return true
	}
	if json.Unmarshal(left, &l) != nil || json.Unmarshal(right, &r) != nil {
		return false
	}
	lc, _ := json.Marshal(l)
	rc, _ := json.Marshal(r)
	return string(lc) == string(rc)
}

func encodeWorkspacePlacementCursor(createdAt time.Time, id string) string {
	value, _ := json.Marshal(workspacePlacementCursor{CreatedAt: createdAt, ID: id})
	return base64.RawURLEncoding.EncodeToString(value)
}

func decodeWorkspacePlacementCursor(cursor string) (workspacePlacementCursor, error) {
	if strings.TrimSpace(cursor) == "" {
		return workspacePlacementCursor{}, nil
	}
	value, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return workspacePlacementCursor{}, ErrInvalid
	}
	var decoded workspacePlacementCursor
	if json.Unmarshal(value, &decoded) != nil || decoded.CreatedAt.IsZero() || uuid.Validate(decoded.ID) != nil {
		return workspacePlacementCursor{}, ErrInvalid
	}
	return decoded, nil
}

func nullPlacementTime(value time.Time) any {
	if value.IsZero() {
		return nil
	}
	return value
}

func nullPlacementString(value string) any {
	if value == "" {
		return nil
	}
	return value
}
