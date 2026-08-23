package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

// Product notification writes are canonical SQL mutations; database triggers
// own CDC and the store has no change-event hook.
var _ ports.NotificationStore = (*Store)(nil)

const notificationColumns = `id, session_id, project_id, pr_url, type, title, body, status, created_at, resolved_at`

func (s *Store) CreateNotification(ctx context.Context, rec domain.NotificationRecord) (domain.NotificationRecord, bool, error) {
	if err := rec.Validate(); err != nil {
		return domain.NotificationRecord{}, false, err
	}
	var out domain.NotificationRecord
	created := false
	err := s.withTenantTx(ctx, pgx.TxOptions{}, func(tx pgx.Tx, id tenant.Identity) error {
		err := scanProductNotification(tx.QueryRow(ctx, `INSERT INTO ao_notifications(
			org_id,owner_user_id,id,session_id,project_id,pr_url,type,title,body,status,created_at)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
			ON CONFLICT DO NOTHING RETURNING `+notificationColumns,
			id.OrgID, id.UserID, rec.ID, rec.SessionID, rec.ProjectID, rec.PRURL, rec.Type, rec.Title, rec.Body, rec.Status, rec.CreatedAt.UTC()), &out)
		if err == nil {
			created = true
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return normalizeError(err)
		}
		err = scanProductNotification(tx.QueryRow(ctx, `SELECT `+notificationColumns+` FROM ao_notifications
			WHERE org_id=$1 AND owner_user_id=$2 AND session_id=$3 AND type=$4 AND pr_url=$5
			  AND (status='unread' OR resolved_at IS NULL) LIMIT 1`, id.OrgID, id.UserID, rec.SessionID, rec.Type, rec.PRURL), &out)
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("create notification %s: conflict without open row", rec.ID)
		}
		return err
	})
	return out, created, err
}

func (s *Store) ListNotifications(ctx context.Context, status domain.NotificationListStatus, before time.Time, beforeID string, limit int) ([]domain.NotificationRecord, error) {
	var out []domain.NotificationRecord
	err := s.withTenantTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx pgx.Tx, id tenant.Identity) error {
		filter := "TRUE"
		switch status {
		case domain.NotificationListUnread:
			filter = "status='unread'"
		case domain.NotificationListUnresolved:
			filter = "resolved_at IS NULL AND type IN ('needs_input','ready_to_merge')"
		}
		rows, err := tx.Query(ctx, `SELECT `+notificationColumns+` FROM ao_notifications WHERE org_id=$1 AND owner_user_id=$2 AND (`+filter+`) AND ($3='' OR created_at<$4 OR (created_at=$4 AND id<$3)) ORDER BY created_at DESC,id DESC LIMIT $5`, id.OrgID, id.UserID, beforeID, nullableTime(before), limit)
		if err != nil {
			return normalizeError(err)
		}
		defer rows.Close()
		for rows.Next() {
			var rec domain.NotificationRecord
			if err := scanProductNotification(rows, &rec); err != nil {
				return err
			}
			out = append(out, rec)
		}
		return rows.Err()
	})
	return out, err
}

func (s *Store) CountUnreadNotifications(ctx context.Context) (int64, error) {
	return s.countProductNotifications(ctx, "status='unread'")
}
func (s *Store) CountUnresolvedNotifications(ctx context.Context) (int64, error) {
	return s.countProductNotifications(ctx, "resolved_at IS NULL AND type IN ('needs_input','ready_to_merge')")
}
func (s *Store) countProductNotifications(ctx context.Context, filter string) (int64, error) {
	var n int64
	err := s.withTenantTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx pgx.Tx, id tenant.Identity) error {
		return tx.QueryRow(ctx, `SELECT count(*) FROM ao_notifications WHERE org_id=$1 AND owner_user_id=$2 AND (`+filter+`)`, id.OrgID, id.UserID).Scan(&n)
	})
	return n, err
}

func (s *Store) MarkNotificationRead(ctx context.Context, notificationID string) (domain.NotificationRecord, bool, error) {
	var out domain.NotificationRecord
	err := s.withTenantTx(ctx, pgx.TxOptions{}, func(tx pgx.Tx, id tenant.Identity) error {
		return scanProductNotification(tx.QueryRow(ctx, `UPDATE ao_notifications SET status='read' WHERE org_id=$1 AND owner_user_id=$2 AND id=$3 AND status='unread' RETURNING `+notificationColumns, id.OrgID, id.UserID, notificationID), &out)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.NotificationRecord{}, false, nil
	}
	return out, err == nil, err
}
func (s *Store) MarkAllNotificationsRead(ctx context.Context) (int64, error) {
	return s.markProductNotificationsRead(ctx, nil)
}
func (s *Store) MarkNotificationsRead(ctx context.Context, ids []string) (int64, error) {
	return s.markProductNotificationsRead(ctx, ids)
}
func (s *Store) markProductNotificationsRead(ctx context.Context, ids []string) (int64, error) {
	var n int64
	err := s.withTenantTx(ctx, pgx.TxOptions{}, func(tx pgx.Tx, id tenant.Identity) error {
		query := `UPDATE ao_notifications SET status='read' WHERE org_id=$1 AND owner_user_id=$2 AND status='unread'`
		args := []any{id.OrgID, id.UserID}
		if ids != nil {
			query += ` AND id=ANY($3::text[])`
			args = append(args, ids)
		}
		tag, e := tx.Exec(ctx, query, args...)
		n = tag.RowsAffected()
		return normalizeError(e)
	})
	return n, err
}

func (s *Store) ResolveSessionNotifications(ctx context.Context, sid domain.SessionID, typ domain.NotificationType, at time.Time) ([]domain.NotificationRecord, error) {
	return s.resolveProductNotifications(ctx, `session_id=$3`, []any{sid}, typ, at)
}
func (s *Store) ResolvePRNotifications(ctx context.Context, url string, typ domain.NotificationType, at time.Time) ([]domain.NotificationRecord, error) {
	return s.resolveProductNotifications(ctx, `pr_url=$3`, []any{url}, typ, at)
}
func (s *Store) resolveProductNotifications(ctx context.Context, predicate string, args []any, typ domain.NotificationType, at time.Time) ([]domain.NotificationRecord, error) {
	var out []domain.NotificationRecord
	err := s.withTenantTx(ctx, pgx.TxOptions{}, func(tx pgx.Tx, id tenant.Identity) error {
		params := []any{id.OrgID, id.UserID}
		params = append(params, args...)
		params = append(params, typ, at.UTC())
		rows, e := tx.Query(ctx, `UPDATE ao_notifications SET resolved_at=$5 WHERE org_id=$1 AND owner_user_id=$2 AND `+predicate+` AND type=$4 AND resolved_at IS NULL RETURNING `+notificationColumns, params...)
		if e != nil {
			return normalizeError(e)
		}
		defer rows.Close()
		for rows.Next() {
			var rec domain.NotificationRecord
			if e := scanProductNotification(rows, &rec); e != nil {
				return e
			}
			out = append(out, rec)
		}
		return rows.Err()
	})
	return out, err
}

func (s *Store) ReconcileResolvedNotifications(ctx context.Context, at time.Time) ([]domain.NotificationRecord, error) {
	var out []domain.NotificationRecord
	err := s.withTenantTx(ctx, pgx.TxOptions{}, func(tx pgx.Tx, id tenant.Identity) error {
		rows, e := tx.Query(ctx, `UPDATE ao_notifications n SET resolved_at=$3
			WHERE n.org_id=$1 AND n.owner_user_id=$2 AND n.type='needs_input' AND n.resolved_at IS NULL
			AND EXISTS(SELECT 1 FROM ao_sessions s WHERE s.org_id=n.org_id AND s.owner_user_id=n.owner_user_id AND s.id=n.session_id AND (s.is_terminated OR s.activity_state NOT IN ('waiting_input','blocked')))
			RETURNING `+notificationColumns, id.OrgID, id.UserID, at.UTC())
		if e != nil {
			return e
		}
		for rows.Next() {
			var rec domain.NotificationRecord
			if e := scanProductNotification(rows, &rec); e != nil {
				rows.Close()
				return e
			}
			out = append(out, rec)
		}
		rows.Close()
		candidates, e := tx.Query(ctx, `SELECT n.id,n.pr_url,p.pr_state,p.ci_state,p.review_decision,p.mergeability,
			EXISTS(SELECT 1 FROM ao_pull_request_comments c WHERE c.org_id=p.org_id AND c.owner_user_id=p.owner_user_id AND c.pr_url=p.url AND NOT c.resolved AND NOT c.is_bot)
			FROM ao_notifications n JOIN ao_pull_requests p ON p.org_id=n.org_id AND p.owner_user_id=n.owner_user_id AND p.url=n.pr_url
			WHERE n.org_id=$1 AND n.owner_user_id=$2 AND n.type='ready_to_merge' AND n.resolved_at IS NULL`, id.OrgID, id.UserID)
		if e != nil {
			return e
		}
		var stale []string
		for candidates.Next() {
			var nid, url string
			var state domain.PRState
			var ci domain.CIState
			var review domain.ReviewDecision
			var merge domain.Mergeability
			var unresolved bool
			if e := candidates.Scan(&nid, &url, &state, &ci, &review, &merge, &unresolved); e != nil {
				candidates.Close()
				return e
			}
			ready := domain.MergeReadiness{Draft: state == domain.PRStateDraft, Merged: state == domain.PRStateMerged, Closed: state == domain.PRStateClosed, CI: ci, Review: review, Mergeability: merge, UnresolvedComments: unresolved}.ReadyToMerge()
			if !ready {
				stale = append(stale, nid)
			}
		}
		candidates.Close()
		if len(stale) > 0 {
			resolved, e := tx.Query(ctx, `UPDATE ao_notifications SET resolved_at=$3 WHERE org_id=$1 AND owner_user_id=$2 AND id=ANY($4::text[]) RETURNING `+notificationColumns, id.OrgID, id.UserID, at.UTC(), stale)
			if e != nil {
				return e
			}
			for resolved.Next() {
				var rec domain.NotificationRecord
				if e := scanProductNotification(resolved, &rec); e != nil {
					resolved.Close()
					return e
				}
				out = append(out, rec)
			}
			resolved.Close()
		}
		return nil
	})
	return out, err
}

func scanProductNotification(row scanRow, rec *domain.NotificationRecord) error {
	var resolved *time.Time
	err := row.Scan(&rec.ID, &rec.SessionID, &rec.ProjectID, &rec.PRURL, &rec.Type, &rec.Title, &rec.Body, &rec.Status, &rec.CreatedAt, &resolved)
	if resolved != nil {
		rec.ResolvedAt = *resolved
	}
	return err
}
