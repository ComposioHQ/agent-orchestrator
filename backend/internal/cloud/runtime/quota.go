package runtime

import (
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
