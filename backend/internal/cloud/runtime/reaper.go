package runtime

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"
)

// CapabilityPurger drops capability rows that stopped being usable. It is
// separate from Capabilities so the reaper can be given purge authority
// without issuance authority.
type CapabilityPurger interface {
	PurgeExpired(ctx context.Context, retain time.Duration) (int, error)
}

// ReaperPolicy bounds how long the compute plane pays for compute nobody is
// using, and how long a leak survives.
//
// Every timeout is measured from the last evidence the placement is WANTED —
// an authenticated heartbeat, or the row's creation instant when no heartbeat
// ever arrived. That fallback is deliberate: a sandbox provisioned for a
// session nobody attached to is the most expensive failure mode, and a policy
// keyed only on heartbeats would never collect it.
type ReaperPolicy struct {
	// IdleTimeout stops a running sandbox that has gone quiet. Stopping keeps
	// the disk, so the session can resume, and revokes the capability.
	IdleTimeout time.Duration
	// AbandonedTimeout deletes a placement that has been quiet far longer.
	// It must exceed IdleTimeout or a sandbox would be deleted before it was
	// ever given the chance to be stopped.
	AbandonedTimeout time.Duration
	// ProvisioningTimeout deletes a placement stuck mid-launch. Without it a
	// row whose create died between the insert and the provider call would sit
	// in provisioning forever, holding quota.
	ProvisioningTimeout time.Duration
	// OrphanGrace is how long a labelled sandbox with no matching row is left
	// alone before deletion. It must be comfortably longer than a create
	// round-trip, because the window it protects is exactly "the row was read
	// before the create response was written".
	OrphanGrace time.Duration
	// UnlabeledGrace is the same protection for a sandbox carrying no usable
	// AO attribution.
	UnlabeledGrace time.Duration
	// ReapUnlabeled enables deletion of unattributable sandboxes. Enable it
	// only when the provider account belongs to this deployment alone: it
	// deletes anything it cannot attribute, which is the point (a leak has no
	// labels to find it by) and the risk.
	ReapUnlabeled bool
	// CapabilityRetention is how long expired or revoked grant rows are kept
	// before purging.
	CapabilityRetention time.Duration
	// MaxProviderDeletesPerRun is a hard blast-radius limit for provider-only
	// orphan/leak deletion. Placement cascades are credential-first and are not
	// counted here. The pass reports and defers candidates beyond this limit.
	MaxProviderDeletesPerRun int
}

// DefaultReaperPolicy is a conservative starting point.
func DefaultReaperPolicy() ReaperPolicy {
	return ReaperPolicy{
		IdleTimeout:              30 * time.Minute,
		AbandonedTimeout:         24 * time.Hour,
		ProvisioningTimeout:      15 * time.Minute,
		OrphanGrace:              30 * time.Minute,
		UnlabeledGrace:           6 * time.Hour,
		ReapUnlabeled:            false,
		CapabilityRetention:      7 * 24 * time.Hour,
		MaxProviderDeletesPerRun: 25,
	}
}

// Validate rejects a policy that cannot converge.
func (p ReaperPolicy) Validate() error {
	if p.IdleTimeout < 0 || p.AbandonedTimeout < 0 || p.ProvisioningTimeout < 0 ||
		p.OrphanGrace < 0 || p.UnlabeledGrace < 0 || p.CapabilityRetention < 0 {
		return fmt.Errorf("%w: reaper timeouts must not be negative", ErrInvalid)
	}
	if p.IdleTimeout > 0 && p.AbandonedTimeout > 0 && p.AbandonedTimeout <= p.IdleTimeout {
		return fmt.Errorf("%w: the abandoned timeout must exceed the idle timeout", ErrInvalid)
	}
	if p.ReapUnlabeled && p.UnlabeledGrace <= 0 {
		return fmt.Errorf("%w: reaping unlabelled sandboxes requires a positive grace period", ErrInvalid)
	}
	if p.MaxProviderDeletesPerRun <= 0 {
		return fmt.Errorf("%w: provider delete breaker limit must be positive", ErrInvalid)
	}
	return nil
}

// ReapReport is one reconciliation pass's outcome. Every field names runtime
// row ids except Orphans and Leaks, which name provider sandbox ids because
// those had no row.
type ReapReport struct {
	// Scanned is how many placement rows the pass examined.
	Scanned int
	// ProviderScanned is how many provider sandboxes the sweep examined.
	ProviderScanned int
	// Repaired names rows whose recorded state disagreed with the provider and
	// was corrected. The provider is the authority for whether compute exists.
	Repaired []string
	// Converged names rows the pass pushed back towards their desired state,
	// which is the other direction of the same reconciliation.
	Converged []string
	// Lost names rows whose sandbox had vanished from the provider.
	Lost []string
	// Stopped names placements stopped for idleness.
	Stopped []string
	// Deleted names placements torn down (abandoned, stuck provisioning, or
	// resumed from an interrupted delete).
	Deleted []string
	// Orphans names provider sandboxes carrying this deployment's labels but
	// with no live placement row; they were deleted.
	Orphans []string
	// Leaks names provider sandboxes with no usable AO attribution that were
	// deleted under ReapUnlabeled.
	Leaks []string
	// Unattributed names sandboxes with no usable attribution that were left
	// alone, either because ReapUnlabeled is off or because they are inside
	// the grace period. They are reported so a deployment can see a growing
	// leak it has not authorized the reaper to clean.
	Unattributed []string
	// PurgedCapabilities is how many spent grant rows were dropped.
	PurgedCapabilities int
	// DeleteBreakerTripped reports that provider-only cleanup reached its hard
	// per-pass deletion cap. DeferredProviderDeletes names candidates left for
	// a later pass or operator review.
	DeleteBreakerTripped    bool
	DeferredProviderDeletes []string
	// Errors are per-item failures. A pass reports them and keeps going: one
	// wedged sandbox must not stop the rest of the fleet being reconciled.
	Errors []error
}

// Reaper reconciles placement rows against provider state in both directions.
type Reaper struct {
	manager    *Manager
	purger     CapabilityPurger
	policy     ReaperPolicy
	deployment string
	now        func() time.Time
	logger     *slog.Logger
}

// NewReaper builds a reconciler over an existing Manager. The purger may be
// nil, in which case spent capability rows are left for another job.
func NewReaper(manager *Manager, purger CapabilityPurger, policy ReaperPolicy) (*Reaper, error) {
	if manager == nil {
		return nil, errors.New("reaper requires a compute manager")
	}
	if err := policy.Validate(); err != nil {
		return nil, err
	}
	return &Reaper{
		manager:    manager,
		purger:     purger,
		policy:     policy,
		deployment: manager.deployment,
		now:        manager.now,
		logger:     manager.logger,
	}, nil
}

// Run performs one reconciliation pass.
//
// It returns an error only when it could not enumerate the placement rows at
// all; every other failure is recorded in the report so a single wedged
// placement or sandbox cannot stop the pass. Callers should log
// len(report.Errors) and alert on it staying non-zero across passes.
func (r *Reaper) Run(ctx context.Context) (ReapReport, error) {
	records, err := r.manager.store.List(ctx, Filter{})
	if err != nil {
		return ReapReport{}, fmt.Errorf("list placements: %w", err)
	}
	report := ReapReport{Scanned: len(records)}
	claimed := make(map[string]struct{}, len(records))
	for _, record := range records {
		if record.ProviderID != "" {
			claimed[record.ProviderID] = struct{}{}
		}
		r.reconcileRecord(ctx, record, &report)
	}
	r.sweepProvider(ctx, claimed, &report)
	r.purgeCapabilities(ctx, &report)
	return report, nil
}

// RunLoop runs a pass immediately and then on every tick until the context is
// cancelled. A pass that fails to enumerate placements is logged and retried
// on the next tick rather than terminating the loop.
func (r *Reaper) RunLoop(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = time.Minute
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		report, err := r.Run(ctx)
		if err != nil {
			r.logger.Error("cloud sandbox reconciliation failed", "error", err)
		} else if len(report.Errors) > 0 {
			r.logger.Warn("cloud sandbox reconciliation completed with failures",
				"scanned", report.Scanned, "failures", len(report.Errors))
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// reconcileRecord drives one placement row towards the truth.
func (r *Reaper) reconcileRecord(ctx context.Context, record Record, report *ReapReport) {
	now := r.now().UTC()
	ref := record.Ref()

	// An interrupted delete is resumed first: the row already recorded the
	// intent, so nothing else about it matters.
	if record.State == StateDeleting {
		if err := r.manager.finishDelete(ctx, record); err != nil {
			report.Errors = append(report.Errors, fmt.Errorf("resume delete %s: %w", ref, err))
			return
		}
		report.Deleted = append(report.Deleted, record.ID)
		return
	}

	if record.ProviderID == "" {
		// The row exists but no sandbox was ever attributed to it. Give the
		// in-flight create its window, then reclaim the quota it holds. Only a
		// row still in provisioning is reclaimed: a row in any other state
		// with no provider id is a stale read (the provider sweep re-reads it
		// before treating its sandbox as an orphan), not a stalled launch.
		if record.State == StateProvisioning && r.policy.ProvisioningTimeout > 0 &&
			record.CreatedAt.Add(r.policy.ProvisioningTimeout).Before(now) {
			if err := r.manager.finishDelete(ctx, record); err != nil {
				report.Errors = append(report.Errors, fmt.Errorf("delete stalled placement %s: %w", ref, err))
				return
			}
			report.Deleted = append(report.Deleted, record.ID)
		}
		return
	}

	sandbox, err := r.manager.provider.Get(ctx, record.ProviderID)
	if errors.Is(err, ErrSandboxNotFound) {
		r.reconcileLostSandbox(ctx, record, now, report)
		return
	}
	if err != nil {
		report.Errors = append(report.Errors, fmt.Errorf("inspect sandbox for %s: %w", ref, providerFailure("get sandbox", err)))
		return
	}

	// Provider truth wins for observed state.
	observed := stateFor(sandbox.State)
	if observed != record.State {
		updated, saveErr := r.manager.observe(ctx, record, sandbox, now)
		if saveErr != nil {
			report.Errors = append(report.Errors, fmt.Errorf("record observed state for %s: %w", ref, saveErr))
			return
		}
		record = updated
		report.Repaired = append(report.Repaired, record.ID)
	}

	idle := lastContact(record)
	switch {
	case r.policy.AbandonedTimeout > 0 && idle.Add(r.policy.AbandonedTimeout).Before(now):
		if err := r.manager.finishDelete(ctx, record); err != nil {
			report.Errors = append(report.Errors, fmt.Errorf("delete abandoned placement %s: %w", ref, err))
			return
		}
		report.Deleted = append(report.Deleted, record.ID)
	case record.DesiredState == StateStopped && record.State == StateRunning:
		// The other direction of reconciliation: the control plane wants this
		// stopped and the provider disagrees, so push the intent out again.
		if _, err := r.manager.Stop(ctx, ref); err != nil {
			report.Errors = append(report.Errors, fmt.Errorf("converge %s to stopped: %w", ref, err))
			return
		}
		report.Converged = append(report.Converged, record.ID)
	case r.policy.IdleTimeout > 0 && record.State == StateRunning && idle.Add(r.policy.IdleTimeout).Before(now):
		if _, err := r.manager.Stop(ctx, ref); err != nil {
			report.Errors = append(report.Errors, fmt.Errorf("stop idle placement %s: %w", ref, err))
			return
		}
		report.Stopped = append(report.Stopped, record.ID)
	}
}

// reconcileLostSandbox handles a row whose sandbox no longer exists. Nothing
// is leaking, so the only question is whether the placement is still wanted:
// a recently active session gets its row marked failed so the next Ensure
// re-provisions onto the same row and label set, while a quiet one is removed.
func (r *Reaper) reconcileLostSandbox(ctx context.Context, record Record, now time.Time, report *ReapReport) {
	ref := record.Ref()
	if r.policy.AbandonedTimeout > 0 && lastContact(record).Add(r.policy.AbandonedTimeout).Before(now) {
		if err := r.manager.finishDelete(ctx, record); err != nil {
			report.Errors = append(report.Errors, fmt.Errorf("delete lost placement %s: %w", ref, err))
			return
		}
		report.Deleted = append(report.Deleted, record.ID)
		return
	}
	if record.State == StateFailed {
		report.Lost = append(report.Lost, record.ID)
		return
	}
	record.State = StateFailed
	record.Error = "sandbox no longer exists at the provider"
	record.UpdatedAt = now
	if _, err := r.manager.store.Save(ctx, record); err != nil {
		report.Errors = append(report.Errors, fmt.Errorf("record lost sandbox for %s: %w", ref, err))
		return
	}
	report.Lost = append(report.Lost, record.ID)
}

// sweepProvider is the provider-to-database direction: everything the provider
// holds that the control plane cannot account for.
func (r *Reaper) sweepProvider(ctx context.Context, claimed map[string]struct{}, report *ReapReport) {
	sandboxes, err := r.manager.provider.List(ctx, Selector{})
	if err != nil {
		report.Errors = append(report.Errors, fmt.Errorf("list provider sandboxes: %w", providerFailure("list sandboxes", err)))
		return
	}
	now := r.now().UTC()
	report.ProviderScanned = len(sandboxes)
	providerDeletes := 0
	for _, sandbox := range sandboxes {
		if _, ok := claimed[sandbox.ID]; ok {
			continue
		}
		attribution, attributed := sandbox.Attribution()
		if !attributed {
			r.sweepUnattributed(ctx, sandbox, now, &providerDeletes, report)
			continue
		}
		if attribution.Deployment != r.deployment {
			// Another control plane's sandbox in a shared provider account.
			continue
		}
		// Labelled as ours but unclaimed by any row: either the row is gone or
		// the create response was lost. Either way it is compute nobody can
		// reach. Confirm the row really does not point at it before deleting.
		if r.rowStillClaims(ctx, attribution.RuntimeID, sandbox.ID) {
			continue
		}
		if !r.past(sandbox.CreatedAt, r.policy.OrphanGrace, now) {
			continue
		}
		if !r.allowProviderDelete(sandbox.ID, providerDeletes, report) {
			continue
		}
		if err := r.manager.provider.Delete(ctx, sandbox.ID); err != nil && !errors.Is(err, ErrSandboxNotFound) {
			report.Errors = append(report.Errors, fmt.Errorf("delete orphan sandbox %s: %w", sandbox.ID, providerFailure("delete sandbox", err)))
			continue
		}
		providerDeletes++
		r.logger.Warn("deleted orphaned cloud sandbox",
			"provider_sandbox", sandbox.ID, "runtime", attribution.RuntimeID,
			"org", attribution.OrgID, "workspace", attribution.WorkspaceID, "session", attribution.SessionID)
		report.Orphans = append(report.Orphans, sandbox.ID)
	}
}

// sweepUnattributed handles a sandbox whose labels cannot name a tenant. This
// is the leak case the label scheme exists to catch: a create whose labels
// never landed, or a sandbox made by hand. It is deleted only when the
// deployment has opted in, because the same rule would delete an unrelated
// sandbox in a shared provider account.
func (r *Reaper) sweepUnattributed(ctx context.Context, sandbox Sandbox, now time.Time, providerDeletes *int, report *ReapReport) {
	if !r.policy.ReapUnlabeled || !r.past(sandbox.CreatedAt, r.policy.UnlabeledGrace, now) {
		report.Unattributed = append(report.Unattributed, sandbox.ID)
		return
	}
	if !r.allowProviderDelete(sandbox.ID, *providerDeletes, report) {
		return
	}
	if err := r.manager.provider.Delete(ctx, sandbox.ID); err != nil && !errors.Is(err, ErrSandboxNotFound) {
		report.Errors = append(report.Errors, fmt.Errorf("delete unattributed sandbox %s: %w", sandbox.ID, providerFailure("delete sandbox", err)))
		return
	}
	(*providerDeletes)++
	r.logger.Warn("deleted unattributed cloud sandbox", "provider_sandbox", sandbox.ID)
	report.Leaks = append(report.Leaks, sandbox.ID)
}

func (r *Reaper) allowProviderDelete(id string, deleted int, report *ReapReport) bool {
	if deleted < r.policy.MaxProviderDeletesPerRun {
		return true
	}
	report.DeleteBreakerTripped = true
	report.DeferredProviderDeletes = append(report.DeferredProviderDeletes, id)
	return false
}

// rowStillClaims re-reads the placement row a sandbox's label points at. The
// listing is a snapshot; a create that completed between the row scan and the
// provider listing would otherwise look like an orphan.
func (r *Reaper) rowStillClaims(ctx context.Context, runtimeID, sandboxID string) bool {
	if runtimeID == "" {
		return false
	}
	record, err := r.manager.store.GetByID(ctx, runtimeID)
	if err != nil {
		// Treat an unreadable row as "still claimed" and try again next pass:
		// deleting live compute because the database blipped is far worse than
		// letting a leak survive one interval.
		return !errors.Is(err, ErrNotFound)
	}
	return record.ProviderID == sandboxID
}

// past reports whether an instant is older than a grace period. An unknown
// (zero) creation time never satisfies it: a provider that cannot say how old
// a sandbox is must not have its sandboxes deleted on a guess.
func (r *Reaper) past(instant time.Time, grace time.Duration, now time.Time) bool {
	if instant.IsZero() {
		return false
	}
	return instant.Add(grace).Before(now)
}

func (r *Reaper) purgeCapabilities(ctx context.Context, report *ReapReport) {
	if r.purger == nil {
		return
	}
	purged, err := r.purger.PurgeExpired(ctx, r.policy.CapabilityRetention)
	if err != nil {
		report.Errors = append(report.Errors, fmt.Errorf("purge spent capabilities: %w", err))
		return
	}
	report.PurgedCapabilities = purged
}
