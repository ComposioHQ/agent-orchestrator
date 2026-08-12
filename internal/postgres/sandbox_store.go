package postgres

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
	"github.com/jackc/pgx/v5"
)

var (
	// ErrSandboxLeaseLost indicates that another reconciler owns the lease.
	ErrSandboxLeaseLost = errors.New("sandbox reconciliation lease lost")
	// ErrInvalidTicket indicates an unknown, expired, or already-consumed ticket.
	ErrInvalidTicket = errors.New("access ticket is invalid or expired")
	// ErrStaleWorker indicates a worker whose connection epoch has been replaced.
	ErrStaleWorker = errors.New("worker connection epoch has been replaced")
)

const sandboxColumns = `sandbox.session_id, sandbox.org_id, sandbox.provider,
	COALESCE(sandbox.provider_environment_id, ''),
	COALESCE(sandbox.provider_connection_id::text, ''),
	sandbox.desired_state, sandbox.observed_state,
	sandbox.resource_profile, sandbox.bootstrap_context,
	sandbox.worker_last_seen_at,
	sandbox.last_error, sandbox.updated_at`

// ClaimSandboxes leases up to limit due sandboxes for reconciliation. The
// SKIP LOCKED claim is what makes the reconcile loop safe to run under multiple
// control-plane replicas: two replicas never claim the same row.
func (s *Store) ClaimSandboxes(
	ctx context.Context,
	owner string,
	limit int,
	lease time.Duration,
) ([]domain.Sandbox, error) {
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	sandboxes := make([]domain.Sandbox, 0, limit)
	err := s.withService(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(
			ctx,
			`WITH candidates AS (
				SELECT session_id
				FROM ao_sandboxes
				WHERE reconcile_after <= now()
					AND (reconcile_lease_until IS NULL OR reconcile_lease_until < now())
					AND (observed_state <> 'deleted' OR desired_state <> 'deleted')
				ORDER BY reconcile_after, created_at
				FOR UPDATE SKIP LOCKED
				LIMIT $1
			)
			UPDATE ao_sandboxes sandbox
			SET reconcile_lease_owner = $2,
				reconcile_lease_until = now() + $3::interval
			FROM candidates
			WHERE sandbox.session_id = candidates.session_id
			RETURNING `+sandboxColumns,
			limit,
			owner,
			intervalString(lease),
		)
		if err != nil {
			return fmt.Errorf("claim sandboxes: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			record, err := scanSandbox(rows)
			if err != nil {
				return err
			}
			sandboxes = append(sandboxes, record)
		}
		if err := rows.Err(); err != nil {
			return fmt.Errorf("iterate sandbox claims: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return sandboxes, nil
}

// RenewSandboxClaim extends a live lease. Requiring the lease to still be
// unexpired fences a reconciler that paused past its deadline even when no
// replacement owner has claimed the row yet.
func (s *Store) RenewSandboxClaim(
	ctx context.Context,
	owner, orgID, sessionID string,
	lease time.Duration,
) error {
	return s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		tag, err := tx.Exec(
			ctx,
			`UPDATE ao_sandboxes
			SET reconcile_lease_until = now() + $3::interval
			WHERE session_id = $1
				AND org_id = $4
				AND reconcile_lease_owner = $2
				AND reconcile_lease_until > now()`,
			sessionID,
			owner,
			intervalString(lease),
			orgID,
		)
		if err != nil {
			return fmt.Errorf("renew sandbox claim: %w", err)
		}
		if tag.RowsAffected() == 0 {
			return ErrSandboxLeaseLost
		}
		return nil
	})
}

// UpdateSandboxObservation records what the provider reported and releases the
// reconciliation lease. Clearing the provider environment ID also clears the
// worker heartbeat, so a replaced sandbox starts its startup deadline afresh.
func (s *Store) UpdateSandboxObservation(
	ctx context.Context,
	owner, orgID, sessionID string,
	providerEnvironmentID, observedState, lastError string,
	reconcileAfter time.Time,
) error {
	return s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		tag, err := tx.Exec(
			ctx,
			`UPDATE ao_sandboxes
			SET provider_environment_id = NULLIF($3, ''),
				observed_state = $4,
				last_error = $5,
				reconcile_after = $6,
				reconcile_lease_owner = '',
				reconcile_lease_until = NULL,
				worker_last_seen_at = CASE
					WHEN $4 IN ('requested', 'provisioning', 'bootstrapping')
						AND (
							provider_environment_id IS DISTINCT FROM NULLIF($3, '')
							OR observed_state IS DISTINCT FROM $4
						)
						THEN NULL
					ELSE worker_last_seen_at
				END,
				updated_at = CASE
					WHEN provider_environment_id IS DISTINCT FROM NULLIF($3, '')
						OR observed_state IS DISTINCT FROM $4
						OR last_error IS DISTINCT FROM $5
						THEN now()
					ELSE updated_at
				END
			WHERE session_id = $1
				AND org_id = $7
				AND reconcile_lease_owner = $2
				AND reconcile_lease_until > now()`,
			sessionID,
			owner,
			providerEnvironmentID,
			observedState,
			lastError,
			reconcileAfter,
			orgID,
		)
		if err != nil {
			return fmt.Errorf("update sandbox observation: %w", err)
		}
		if tag.RowsAffected() == 0 {
			return ErrSandboxLeaseLost
		}
		return nil
	})
}

// ReleaseSandboxClaim releases a lease and schedules the next attempt.
func (s *Store) ReleaseSandboxClaim(
	ctx context.Context,
	owner, orgID, sessionID string,
	reconcileAfter time.Time,
) error {
	return s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		tag, err := tx.Exec(
			ctx,
			`UPDATE ao_sandboxes
			SET reconcile_after = $3,
				reconcile_lease_owner = '',
				reconcile_lease_until = NULL
			WHERE session_id = $1
				AND org_id = $4
				AND reconcile_lease_owner = $2
				AND reconcile_lease_until > now()`,
			sessionID,
			owner,
			reconcileAfter,
			orgID,
		)
		if err != nil {
			return fmt.Errorf("release sandbox claim: %w", err)
		}
		if tag.RowsAffected() == 0 {
			return ErrSandboxLeaseLost
		}
		return nil
	})
}

// SetSandboxDesiredState records user intent and schedules immediate reconciliation.
func (s *Store) SetSandboxDesiredState(
	ctx context.Context,
	principal domain.Principal,
	orgID, sessionID, desiredState string,
) error {
	return s.withTenant(ctx, principal, orgID, func(tx pgx.Tx) error {
		tag, err := tx.Exec(
			ctx,
			`UPDATE ao_sandboxes
			SET desired_state = $2, reconcile_after = now(), updated_at = now()
			WHERE session_id = $1 AND org_id = $3`,
			sessionID,
			desiredState,
			orgID,
		)
		if err != nil {
			return normalizeConstraintError(err)
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return nil
	})
}

// CountActiveSandboxes counts sandboxes whose provider deletion has not yet
// been observed. Delete intent alone does not release paid capacity.
func (s *Store) CountActiveSandboxes(
	ctx context.Context,
	principal domain.Principal,
	orgID string,
) (int, error) {
	var count int
	err := s.withTenant(ctx, principal, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(
			ctx,
			`SELECT count(*) FROM ao_sandboxes
			WHERE org_id = $1 AND observed_state <> 'deleted'`,
			orgID,
		).Scan(&count)
	})
	return count, err
}

// CompleteSandboxDeletion records confirmed provider absence, releases quota,
// and terminates the session without deleting its history.
func (s *Store) CompleteSandboxDeletion(
	ctx context.Context,
	owner, orgID, sessionID string,
) error {
	return s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		tag, err := tx.Exec(
			ctx,
			`UPDATE ao_sandboxes
			SET provider_environment_id = NULL,
				observed_state = 'deleted',
				worker_last_seen_at = NULL,
				last_error = '',
				reconcile_after = now() + interval '100 years',
				reconcile_lease_owner = '',
				reconcile_lease_until = NULL,
				updated_at = now()
			WHERE session_id = $1
				AND org_id = $3
				AND reconcile_lease_owner = $2
				AND reconcile_lease_until > now()`,
			sessionID,
			owner,
			orgID,
		)
		if err != nil {
			return fmt.Errorf("complete sandbox deletion: %w", err)
		}
		if tag.RowsAffected() == 0 {
			return ErrSandboxLeaseLost
		}
		if _, err := tx.Exec(
			ctx,
			`UPDATE ao_worker_connections
			SET disconnected_at = COALESCE(disconnected_at, now())
			WHERE session_id = $1 AND org_id = $2`,
			sessionID,
			orgID,
		); err != nil {
			return fmt.Errorf("disconnect deleted sandbox workers: %w", err)
		}
		if _, err := tx.Exec(
			ctx,
			`UPDATE ao_sessions
			SET is_terminated = true,
				activity_state = 'exited',
				updated_at = now()
			WHERE id = $1 AND org_id = $2`,
			sessionID,
			orgID,
		); err != nil {
			return fmt.Errorf("terminate deleted sandbox session: %w", err)
		}
		return nil
	})
}

// IssueAccessTicket mints a one-time, capability-scoped grant. Only the token's
// SHA-256 hash is stored; the plaintext is returned once and is the only secret
// that ever enters a sandbox.
func (s *Store) IssueAccessTicket(
	ctx context.Context,
	orgID, sessionID, purpose string,
	scopes []string,
	ttl time.Duration,
) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate access ticket: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	hash := sha256.Sum256([]byte(token))
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		var workerEpoch any
		if purpose == "worker_bootstrap" {
			var epoch int64
			if err := tx.QueryRow(
				ctx,
				`SELECT nextval('ao_worker_epoch_sequence')`,
			).Scan(&epoch); err != nil {
				return fmt.Errorf("reserve worker epoch: %w", err)
			}
			workerEpoch = epoch
			// Only the newest bootstrap ticket may launch. Reserving its epoch
			// also fences the previous worker before a repair starts.
			if _, err := tx.Exec(
				ctx,
				`UPDATE ao_access_tickets
				SET consumed_at = now()
				WHERE org_id = $1
					AND session_id = $2
					AND purpose = 'worker_bootstrap'
					AND consumed_at IS NULL`,
				orgID,
				sessionID,
			); err != nil {
				return fmt.Errorf("invalidate previous bootstrap tickets: %w", err)
			}
			if _, err := tx.Exec(
				ctx,
				`UPDATE ao_worker_connections
				SET disconnected_at = now()
				WHERE org_id = $1
					AND session_id = $2
					AND disconnected_at IS NULL`,
				orgID,
				sessionID,
			); err != nil {
				return fmt.Errorf("fence previous worker epoch: %w", err)
			}
		}
		tag, err := tx.Exec(
			ctx,
			`INSERT INTO ao_access_tickets (
				org_id, session_id, purpose, scopes, token_hash, worker_epoch, expires_at
			)
			SELECT $1, $2, $3, $4, $5, $6, now() + $7::interval
			FROM ao_sessions
			WHERE id = $2 AND org_id = $1`,
			orgID,
			sessionID,
			purpose,
			scopes,
			hash[:],
			workerEpoch,
			intervalString(ttl),
		)
		if err != nil {
			return fmt.Errorf("store access ticket: %w", err)
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	return token, nil
}

// RedeemWorkerBootstrapTicket atomically consumes a bootstrap ticket. Its
// worker epoch was reserved when the ticket was issued, which fences the prior
// worker before a repair or recreate begins.
func (s *Store) RedeemWorkerBootstrapTicket(
	ctx context.Context,
	token string,
) (domain.AccessTicket, error) {
	hash := sha256.Sum256([]byte(token))
	var ticket domain.AccessTicket
	err := s.withService(ctx, func(tx pgx.Tx) error {
		err := tx.QueryRow(
			ctx,
			`UPDATE ao_access_tickets
			SET consumed_at = now(),
				worker_epoch = COALESCE(worker_epoch, nextval('ao_worker_epoch_sequence'))
			WHERE token_hash = $1
				AND purpose = 'worker_bootstrap'
				AND consumed_at IS NULL
				AND expires_at > now()
			RETURNING id, org_id, session_id, purpose, scopes,
				COALESCE(worker_epoch, 0), expires_at`,
			hash[:],
		).Scan(
			&ticket.ID,
			&ticket.OrgID,
			&ticket.SessionID,
			&ticket.Purpose,
			&ticket.Scopes,
			&ticket.WorkerEpoch,
			&ticket.ExpiresAt,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrInvalidTicket
		}
		if err != nil {
			return fmt.Errorf("consume access ticket: %w", err)
		}
		return nil
	})
	if err != nil {
		return domain.AccessTicket{}, err
	}
	return ticket, nil
}

// WorkerLaunchSpec returns the durable context a bootstrapped worker needs.
func (s *Store) WorkerLaunchSpec(
	ctx context.Context,
	orgID, sessionID string,
) (domain.WorkerLaunch, error) {
	launch := domain.WorkerLaunch{OrgID: orgID}
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		err := tx.QueryRow(
			ctx,
			`SELECT session.id, session.project_id, session.kind, session.harness,
				session.display_name, session.branch, session.prompt, session.mode,
				session.denied_commands,
				project.repository_url, project.default_branch
			FROM ao_sessions session
			JOIN ao_projects project ON project.id = session.project_id
			WHERE session.id = $1 AND session.org_id = $2`,
			sessionID,
			orgID,
		).Scan(
			&launch.SessionID,
			&launch.ProjectID,
			&launch.Kind,
			&launch.Harness,
			&launch.DisplayName,
			&launch.Branch,
			&launch.Prompt,
			&launch.Mode,
			&launch.DeniedCommands,
			&launch.RepositoryURL,
			&launch.DefaultBranch,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("load worker launch spec: %w", err)
		}
		return nil
	})
	if err != nil {
		return domain.WorkerLaunch{}, err
	}
	return launch, nil
}

// RegisterWorkerBootstrap records the epoch a bootstrap exchange authorized. It
// does not claim the worker is ready — only a heartbeat does that.
func (s *Store) RegisterWorkerBootstrap(
	ctx context.Context,
	orgID, sessionID, workerID, version string,
	epoch int64,
	capabilities []string,
) error {
	encoded, err := encodeCapabilities(capabilities)
	if err != nil {
		return err
	}
	return s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		return upsertWorkerConnection(ctx, tx, orgID, sessionID, workerID, version, epoch, encoded, false)
	})
}

// WorkerConnectionCurrent reports whether a worker still owns the live epoch.
// A worker replaced by a recreate fails here even though its token still
// verifies, which is what makes stale workers harmless.
func (s *Store) WorkerConnectionCurrent(
	ctx context.Context,
	orgID, sessionID, workerID string,
	epoch int64,
) (bool, error) {
	var current bool
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(
			ctx,
			`SELECT EXISTS (
				SELECT 1 FROM ao_worker_connections
				WHERE session_id = $1
					AND org_id = $4
					AND worker_id = $2
					AND epoch = $3
					AND disconnected_at IS NULL
			)`,
			sessionID,
			workerID,
			epoch,
			orgID,
		).Scan(&current)
	})
	return current, err
}

// MarkWorkerSeen records a heartbeat. This is the only path that promotes a
// sandbox to running: the control plane trusts the worker's own check-in, not
// the provider's opinion that a machine booted.
func (s *Store) MarkWorkerSeen(
	ctx context.Context,
	orgID, sessionID, workerID, version string,
	epoch int64,
	capabilities []string,
) error {
	encoded, err := encodeCapabilities(capabilities)
	if err != nil {
		return err
	}
	return s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		tag, err := tx.Exec(
			ctx,
			`UPDATE ao_sandboxes
			SET worker_last_seen_at = now(),
				observed_state = CASE
					WHEN observed_state IN ('requested', 'provisioning', 'bootstrapping', 'disconnected')
						THEN 'running'
					ELSE observed_state
				END,
				reconcile_after = now() + interval '30 seconds',
				updated_at = now()
			WHERE session_id = $1 AND org_id = $2`,
			sessionID,
			orgID,
		)
		if err != nil {
			return fmt.Errorf("mark sandbox worker seen: %w", err)
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return upsertWorkerConnection(ctx, tx, orgID, sessionID, workerID, version, epoch, encoded, true)
	})
}

func upsertWorkerConnection(
	ctx context.Context,
	tx pgx.Tx,
	orgID, sessionID, workerID, version string,
	epoch int64,
	encodedCapabilities []byte,
	ready bool,
) error {
	// Retiring older epochs first keeps the one-live-worker-per-session index
	// satisfiable when a recreate hands the session to a new worker.
	if _, err := tx.Exec(
		ctx,
		`UPDATE ao_worker_connections
		SET disconnected_at = now()
		WHERE session_id = $1 AND org_id = $3 AND epoch < $2 AND disconnected_at IS NULL`,
		sessionID,
		epoch,
		orgID,
	); err != nil {
		return fmt.Errorf("retire superseded worker connections: %w", err)
	}
	tag, err := tx.Exec(
		ctx,
		`INSERT INTO ao_worker_connections (
			session_id, org_id, sandbox_id, epoch, worker_id, version,
			capabilities, ready_at
		)
		VALUES ($1, $2, $1, $3, $4, $5, $6, CASE WHEN $7 THEN now() ELSE NULL END)
		ON CONFLICT (session_id, epoch) DO UPDATE
		SET worker_id = EXCLUDED.worker_id,
			version = EXCLUDED.version,
			capabilities = EXCLUDED.capabilities,
			last_seen_at = now(),
			ready_at = CASE WHEN $7 THEN now() ELSE ao_worker_connections.ready_at END
		WHERE ao_worker_connections.disconnected_at IS NULL`,
		sessionID,
		orgID,
		epoch,
		workerID,
		version,
		encodedCapabilities,
		ready,
	)
	if err != nil {
		return fmt.Errorf("upsert worker connection: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrStaleWorker
	}
	return nil
}

func encodeCapabilities(capabilities []string) ([]byte, error) {
	if capabilities == nil {
		capabilities = []string{}
	}
	encoded, err := json.Marshal(capabilities)
	if err != nil {
		return nil, fmt.Errorf("encode worker capabilities: %w", err)
	}
	return encoded, nil
}

func scanSandbox(row rowScanner) (domain.Sandbox, error) {
	var record domain.Sandbox
	var resourceProfile, bootstrapContext []byte
	if err := row.Scan(
		&record.SessionID,
		&record.OrgID,
		&record.Provider,
		&record.ProviderEnvironmentID,
		&record.ProviderConnectionID,
		&record.DesiredState,
		&record.ObservedState,
		&resourceProfile,
		&bootstrapContext,
		&record.WorkerLastSeenAt,
		&record.LastError,
		&record.UpdatedAt,
	); err != nil {
		return domain.Sandbox{}, fmt.Errorf("scan sandbox: %w", err)
	}
	record.ResourceProfile = resourceProfile
	record.BootstrapContext = bootstrapContext
	return record, nil
}

type rowScanner interface {
	Scan(...any) error
}

func intervalString(d time.Duration) string {
	seconds := int64(d / time.Second)
	if seconds < 1 {
		seconds = 1
	}
	return strconv.FormatInt(seconds, 10) + " seconds"
}
