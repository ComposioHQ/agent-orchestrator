package postgres

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	cloudruntime "github.com/aoagents/agent-orchestrator/backend/internal/cloud/runtime"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

var _ cloudruntime.Store = (*Store)(nil)

func (s *Store) withRuntimeTx(ctx context.Context, workspaceID string, fn func(pgx.Tx, tenant.Identity) error) error {
	return s.withTenantTx(ctx, pgx.TxOptions{}, func(tx pgx.Tx, identity tenant.Identity) error {
		if strings.TrimSpace(workspaceID) != "" {
			if _, err := tx.Exec(ctx, `SELECT set_config('ao.workspace_id', $1, true)`, workspaceID); err != nil {
				return fmt.Errorf("apply workspace scope: %w", normalizeRuntimeError(err))
			}
		}
		return fn(tx, identity)
	})
}

// Reserve serializes all creates for an organization, evaluates every quota
// from the durable reservation ledger, and inserts the placement plus ledger
// row in one transaction.
func (s *Store) Reserve(ctx context.Context, ref cloudruntime.Ref, quotas cloudruntime.Quotas, now time.Time) (record cloudruntime.Record, created bool, err error) {
	ref = ref.Normalize()
	if err := ref.Validate(); err != nil {
		return record, false, err
	}
	err = s.withRuntimeTx(ctx, ref.WorkspaceID, func(tx pgx.Tx, identity tenant.Identity) error {
		if identity.OrgID != ref.OrgID || identity.UserID != ref.UserID {
			return tenant.ErrNoTenant
		}
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, ref.OrgID); err != nil {
			return normalizeRuntimeError(err)
		}
		row := tx.QueryRow(ctx, runtimeSelect+` WHERE org_id=$1 AND workspace_id=$2 AND session_id=$3`, ref.OrgID, ref.WorkspaceID, ref.SessionID)
		if scanErr := scanRuntime(row, &record); scanErr == nil {
			return nil
		} else if !errors.Is(scanErr, cloudruntime.ErrNotFound) {
			return scanErr
		}
		if err := quotas.CheckCountsForStore(ref, func(filter cloudruntime.Filter) (int, error) {
			var count int
			query := `SELECT count(*) FROM ao_compute_quota_reservations WHERE live`
			args := []any{}
			if filter.OrgID != "" {
				args = append(args, filter.OrgID)
				query += fmt.Sprintf(" AND org_id=$%d", len(args))
			}
			if filter.UserID != "" {
				args = append(args, filter.UserID)
				query += fmt.Sprintf(" AND owner_user_id=$%d", len(args))
			}
			if filter.WorkspaceID != "" {
				args = append(args, filter.WorkspaceID)
				query += fmt.Sprintf(" AND workspace_id=$%d", len(args))
			}
			if filter.Role != "" {
				args = append(args, string(filter.Role))
				query += fmt.Sprintf(" AND role=$%d", len(args))
			}
			if queryErr := tx.QueryRow(ctx, query, args...).Scan(&count); queryErr != nil {
				return 0, normalizeRuntimeError(queryErr)
			}
			return count, nil
		}); err != nil {
			return err
		}
		now = now.UTC()
		row = tx.QueryRow(ctx, `INSERT INTO ao_cloud_session_runtimes
			(org_id, workspace_id, session_id, owner_user_id, role, state, desired_state, created_at, updated_at)
			VALUES ($1,$2,$3,$4,$5,'provisioning','running',$6,$6) RETURNING `+runtimeColumns,
			ref.OrgID, ref.WorkspaceID, ref.SessionID, ref.UserID, string(ref.Role), now)
		if err := scanRuntime(row, &record); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `INSERT INTO ao_compute_quota_reservations
			(runtime_id,org_id,owner_user_id,workspace_id,role,live,created_at)
			VALUES ($1,$2,$3,$4,$5,true,$6)`, record.ID, ref.OrgID, ref.UserID, ref.WorkspaceID, string(ref.Role), now)
		if err != nil {
			return normalizeRuntimeError(err)
		}
		created = true
		return nil
	})
	return record, created, err
}

const runtimeColumns = `id::text,org_id::text,workspace_id::text,session_id,owner_user_id::text,role,sandbox_id,state,desired_state,error,generation,last_heartbeat_at,created_at,updated_at`
const runtimeSelect = `SELECT ` + runtimeColumns + ` FROM ao_cloud_session_runtimes`

type runtimeRowScanner interface{ Scan(...any) error }

func scanRuntime(row runtimeRowScanner, out *cloudruntime.Record) error {
	var heartbeat *time.Time
	err := row.Scan(&out.ID, &out.OrgID, &out.WorkspaceID, &out.SessionID, &out.UserID, &out.Role, &out.ProviderID, &out.State, &out.DesiredState, &out.Error, &out.Generation, &heartbeat, &out.CreatedAt, &out.UpdatedAt)
	if err != nil {
		return normalizeRuntimeError(err)
	}
	if heartbeat != nil {
		out.LastHeartbeatAt = heartbeat.UTC()
	}
	out.CreatedAt = out.CreatedAt.UTC()
	out.UpdatedAt = out.UpdatedAt.UTC()
	return nil
}

// Get loads the runtime placement for ref.
func (s *Store) Get(ctx context.Context, ref cloudruntime.Ref) (out cloudruntime.Record, err error) {
	err = s.withRuntimeTx(ctx, ref.WorkspaceID, func(tx pgx.Tx, _ tenant.Identity) error {
		return scanRuntime(tx.QueryRow(ctx, runtimeSelect+` WHERE org_id=$1 AND workspace_id=$2 AND session_id=$3`, ref.OrgID, ref.WorkspaceID, ref.SessionID), &out)
	})
	return out, err
}

// GetByID loads one runtime placement by durable ID.
func (s *Store) GetByID(ctx context.Context, id string) (out cloudruntime.Record, err error) {
	identity, ok := tenant.FromContext(ctx)
	if !ok {
		return out, tenant.ErrNoTenant
	}
	var workspace string
	err = s.withRuntimeTx(ctx, "", func(tx pgx.Tx, _ tenant.Identity) error {
		return normalizeRuntimeError(tx.QueryRow(ctx, `SELECT workspace_id::text FROM ao_compute_quota_reservations WHERE runtime_id=$1 AND org_id=$2 AND owner_user_id=$3`, id, identity.OrgID, identity.UserID).Scan(&workspace))
	})
	if err != nil {
		return out, err
	}
	err = s.withRuntimeTx(ctx, workspace, func(tx pgx.Tx, _ tenant.Identity) error {
		return scanRuntime(tx.QueryRow(ctx, runtimeSelect+` WHERE id=$1`, id), &out)
	})
	return out, err
}

// Save updates one runtime using generation compare-and-swap.
func (s *Store) Save(ctx context.Context, record cloudruntime.Record) (out cloudruntime.Record, err error) {
	err = s.withRuntimeTx(ctx, record.WorkspaceID, func(tx pgx.Tx, _ tenant.Identity) error {
		row := tx.QueryRow(ctx, `UPDATE ao_cloud_session_runtimes SET sandbox_id=$1,state=$2,desired_state=$3,error=$4,last_heartbeat_at=$5,updated_at=$6,generation=generation+1 WHERE id=$7 AND generation=$8 RETURNING `+runtimeColumns,
			record.ProviderID, string(record.State), string(record.DesiredState), record.Error, nullableTime(record.LastHeartbeatAt), record.UpdatedAt.UTC(), record.ID, record.Generation)
		if err := scanRuntime(row, &out); err != nil {
			if errors.Is(err, cloudruntime.ErrNotFound) {
				return cloudruntime.ErrConflict
			}
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE ao_compute_quota_reservations SET live=$1 WHERE runtime_id=$2`, !out.State.Terminal(), out.ID)
		return normalizeRuntimeError(err)
	})
	return out, err
}

// Delete removes one runtime using generation compare-and-swap.
func (s *Store) Delete(ctx context.Context, id string, generation int64) error {
	record, err := s.GetByID(ctx, id)
	if errors.Is(err, cloudruntime.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	return s.withRuntimeTx(ctx, record.WorkspaceID, func(tx pgx.Tx, _ tenant.Identity) error {
		result, err := tx.Exec(ctx, `DELETE FROM ao_cloud_session_runtimes WHERE id=$1 AND generation=$2`, id, generation)
		if err != nil {
			return normalizeRuntimeError(err)
		}
		if result.RowsAffected() == 0 {
			return cloudruntime.ErrConflict
		}
		return nil
	})
}

// List returns tenant-scoped runtime placements matching filter.
func (s *Store) List(ctx context.Context, filter cloudruntime.Filter) (out []cloudruntime.Record, err error) {
	identity, ok := tenant.FromContext(ctx)
	if !ok {
		return nil, tenant.ErrNoTenant
	}
	workspaces := []string{}
	if filter.WorkspaceID != "" {
		workspaces = []string{filter.WorkspaceID}
	} else {
		err = s.withRuntimeTx(ctx, "", func(tx pgx.Tx, _ tenant.Identity) error {
			rows, e := tx.Query(ctx, `SELECT DISTINCT workspace_id::text FROM ao_compute_quota_reservations WHERE org_id=$1 AND owner_user_id=$2`, identity.OrgID, identity.UserID)
			if e != nil {
				return normalizeRuntimeError(e)
			}
			defer rows.Close()
			for rows.Next() {
				var id string
				if scanErr := rows.Scan(&id); scanErr != nil {
					return scanErr
				}
				workspaces = append(workspaces, id)
			}
			return rows.Err()
		})
		if err != nil {
			return nil, err
		}
	}
	for _, workspace := range workspaces {
		err = s.withRuntimeTx(ctx, workspace, func(tx pgx.Tx, _ tenant.Identity) error {
			rows, e := tx.Query(ctx, runtimeSelect+` ORDER BY created_at,id`)
			if e != nil {
				return normalizeRuntimeError(e)
			}
			defer rows.Close()
			for rows.Next() {
				var r cloudruntime.Record
				if scanErr := scanRuntime(rows, &r); scanErr != nil {
					return scanErr
				}
				if filter.Matches(r) {
					out = append(out, r)
				}
			}
			return rows.Err()
		})
		if err != nil {
			return nil, err
		}
	}
	cloudruntime.SortRecords(out)
	return out, nil
}

// Count returns the number of tenant-scoped runtime placements matching filter.
func (s *Store) Count(ctx context.Context, filter cloudruntime.Filter) (int, error) {
	rows, err := s.List(ctx, filter)
	return len(rows), err
}

func nullableTime(value time.Time) any {
	if value.IsZero() {
		return nil
	}
	return value.UTC()
}

func normalizeRuntimeError(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return cloudruntime.ErrNotFound
	}
	err = normalizeError(err)
	if errors.Is(err, ErrConflict) {
		return cloudruntime.ErrConflict
	}
	if errors.Is(err, ErrNotFound) {
		return cloudruntime.ErrNotFound
	}
	if errors.Is(err, ErrInvalid) {
		return cloudruntime.ErrInvalid
	}
	return err
}
