package runtime

import (
	"context"
	"fmt"
)

// Quotas bound how much compute one tenant can hold at once. A zero limit
// means "unbounded" so a deployment can opt out of a dimension explicitly;
// DefaultQuotas supplies non-zero values, and Validate rejects negatives, so
// an unbounded limit is always a deliberate configuration choice rather than a
// forgotten field.
type Quotas struct {
	// MaxSandboxesPerOrg bounds an organization's total live sandboxes.
	MaxSandboxesPerOrg int
	// MaxSandboxesPerUser bounds one user's live sandboxes. Without it, one
	// member of a shared organization can consume the whole org limit.
	MaxSandboxesPerUser int
	// MaxWorkersPerWorkspace bounds fan-out inside a single workspace, which
	// is the limit a runaway coordinator hits first.
	MaxWorkersPerWorkspace int
	// MaxCoordinatorsPerWorkspace is normally 1. It exists as a limit rather
	// than an assertion so a deployment can allow a brief overlap during a
	// coordinator handover without patching code.
	MaxCoordinatorsPerWorkspace int
}

// DefaultQuotas are the starting limits for a hosted deployment. They are
// deliberately small: the failure mode of a too-low limit is a clear
// QuotaError a human can raise, while the failure mode of a too-high limit is
// an unbounded provider bill.
func DefaultQuotas() Quotas {
	return Quotas{
		MaxSandboxesPerOrg:          20,
		MaxSandboxesPerUser:         10,
		MaxWorkersPerWorkspace:      8,
		MaxCoordinatorsPerWorkspace: 1,
	}
}

// Validate rejects negative limits.
func (q Quotas) Validate() error {
	for name, limit := range map[string]int{
		"AO_CLOUD_MAX_SANDBOXES_PER_ORG":          q.MaxSandboxesPerOrg,
		"AO_CLOUD_MAX_SANDBOXES_PER_USER":         q.MaxSandboxesPerUser,
		"AO_CLOUD_MAX_WORKERS_PER_WORKSPACE":      q.MaxWorkersPerWorkspace,
		"AO_CLOUD_MAX_COORDINATORS_PER_WORKSPACE": q.MaxCoordinatorsPerWorkspace,
	} {
		if limit < 0 {
			return fmt.Errorf("%w: %s must not be negative", ErrInvalid, name)
		}
	}
	return nil
}

// check counts live placements and returns a QuotaError for the first limit
// the new sandbox would exceed. It runs BEFORE the row is inserted, so the
// counts exclude the placement being requested and the comparison is
// "already at the limit".
//
// This is an advisory pre-check, not a reservation: two concurrent creates can
// both observe limit-1 and both succeed. That is deliberate — serializing every
// create behind a tenant lock would be a far worse trade than occasionally
// running one sandbox over a soft limit, and the reconciler reports the excess.
// A hard cap belongs in the provider account's own limits.
func (q Quotas) check(ctx context.Context, store Store, ref Ref) error {
	checks := []struct {
		limit    int
		scope    QuotaScope
		resource string
		subject  string
		filter   Filter
	}{
		{
			limit: q.MaxSandboxesPerOrg, scope: ScopeOrg, resource: "sandboxes", subject: ref.OrgID,
			filter: Filter{OrgID: ref.OrgID, ExcludeTerminal: true},
		},
		{
			limit: q.MaxSandboxesPerUser, scope: ScopeUser, resource: "sandboxes", subject: ref.UserID,
			filter: Filter{UserID: ref.UserID, ExcludeTerminal: true},
		},
		{
			limit: q.workspaceLimit(ref.Role), scope: ScopeWorkspace, resource: string(ref.Role) + "s", subject: ref.WorkspaceID,
			filter: Filter{WorkspaceID: ref.WorkspaceID, Role: ref.Role, ExcludeTerminal: true},
		},
	}
	for _, check := range checks {
		if check.limit <= 0 {
			continue
		}
		inUse, err := store.Count(ctx, check.filter)
		if err != nil {
			return err
		}
		if inUse >= check.limit {
			return &QuotaError{
				Scope:    check.scope,
				Resource: check.resource,
				Subject:  check.subject,
				Limit:    check.limit,
				InUse:    inUse,
			}
		}
	}
	return nil
}

func (q Quotas) workspaceLimit(role Role) int {
	if role == RoleCoordinator {
		return q.MaxCoordinatorsPerWorkspace
	}
	return q.MaxWorkersPerWorkspace
}
