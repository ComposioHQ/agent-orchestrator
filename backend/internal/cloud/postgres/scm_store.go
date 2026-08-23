package postgres

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
)

func (s *Store) IngestAndClaimSCMWebhook(ctx context.Context, receipt domain.SCMWebhookReceipt) (domain.SCMWebhookClaim, error) {
	if strings.TrimSpace(receipt.Provider) != domain.SCMProviderGitHub ||
		strings.TrimSpace(receipt.DeliveryID) == "" || strings.TrimSpace(receipt.Event) == "" ||
		len(receipt.Body) > 2<<20 {
		return domain.SCMWebhookClaim{}, ErrInvalid
	}
	row := s.pool.QueryRow(ctx,
		`SELECT provider, delivery_id, event, body, classification,
		        processing_state, lease_id::text, attempts, first_receipt,
		        claimed, received_at, next_attempt_at, lease_expires_at
		 FROM ao_scm_ingest_and_claim_webhook($1, $2, $3, $4, $5, $6)`,
		receipt.Provider, strings.TrimSpace(receipt.DeliveryID), strings.TrimSpace(receipt.Event),
		receipt.Body, receipt.Classification, receipt.TerminalError,
	)
	claim, err := scanSCMWebhookClaim(row)
	if err != nil {
		return domain.SCMWebhookClaim{}, normalizeError(err)
	}
	return claim, nil
}

func (s *Store) ClaimDueSCMWebhooks(ctx context.Context, limit int) ([]domain.SCMWebhookClaim, error) {
	if limit <= 0 {
		return nil, nil
	}
	rows, err := s.pool.Query(ctx,
		`SELECT provider, delivery_id, event, body, classification,
		        processing_state, lease_id::text, attempts, first_receipt,
		        claimed, received_at, next_attempt_at, lease_expires_at
		 FROM ao_scm_claim_due_webhooks($1, $2)`,
		domain.SCMProviderGitHub, limit,
	)
	if err != nil {
		return nil, normalizeError(err)
	}
	defer rows.Close()
	claims := make([]domain.SCMWebhookClaim, 0, min(limit, 100))
	for rows.Next() {
		claim, scanErr := scanSCMWebhookClaim(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		claims = append(claims, claim)
	}
	if err := rows.Err(); err != nil {
		return nil, normalizeError(err)
	}
	return claims, nil
}

func (s *Store) FinishSCMWebhook(ctx context.Context, deliveryID, leaseID, outcome, errorCode string) (bool, error) {
	if strings.TrimSpace(deliveryID) == "" || strings.TrimSpace(leaseID) == "" {
		return false, ErrInvalid
	}
	var finished bool
	err := s.pool.QueryRow(ctx,
		`SELECT ao_scm_finish_webhook($1, $2, $3::uuid, $4, $5)`,
		domain.SCMProviderGitHub, strings.TrimSpace(deliveryID), strings.TrimSpace(leaseID), outcome, errorCode,
	).Scan(&finished)
	if err != nil {
		return false, normalizeError(err)
	}
	return finished, nil
}

func (s *Store) PruneSCMWebhooks(ctx context.Context, retention time.Duration) (int64, error) {
	if retention <= 0 {
		return 0, ErrInvalid
	}
	var removed int64
	if err := s.pool.QueryRow(ctx, `SELECT ao_scm_prune_webhooks($1::interval)`, retention.String()).Scan(&removed); err != nil {
		return 0, normalizeError(err)
	}
	return removed, nil
}

type scmWebhookScanner interface {
	Scan(...any) error
}

func scanSCMWebhookClaim(row scmWebhookScanner) (domain.SCMWebhookClaim, error) {
	var claim domain.SCMWebhookClaim
	var leaseID *string
	var leaseExpiresAt *time.Time
	err := row.Scan(
		&claim.Provider, &claim.DeliveryID, &claim.Event, &claim.Body,
		&claim.Classification, &claim.State, &leaseID, &claim.Attempts,
		&claim.FirstReceipt, &claim.Claimed, &claim.ReceivedAt,
		&claim.NextAttemptAt, &leaseExpiresAt,
	)
	if err != nil {
		return domain.SCMWebhookClaim{}, err
	}
	if leaseID != nil {
		claim.LeaseID = *leaseID
	}
	if leaseExpiresAt != nil {
		claim.LeaseExpiresAt = *leaseExpiresAt
	}
	if claim.Claimed && claim.LeaseID == "" {
		return domain.SCMWebhookClaim{}, errors.New("claimed SCM webhook is missing its lease id")
	}
	return claim, nil
}
