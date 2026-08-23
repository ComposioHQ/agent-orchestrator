package runtime

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// Role separates the two sandbox classes. They are never co-located: a
// coordinator that could execute worker agent code in its own sandbox would
// hand every worker the coordinator's credentials.
type Role string

const (
	// RoleCoordinator hosts one workspace's orchestrator.
	RoleCoordinator Role = "coordinator"
	// RoleWorker hosts one session's agent.
	RoleWorker Role = "worker"
)

// Valid reports whether a role is one of the two known classes.
func (r Role) Valid() bool { return r == RoleCoordinator || r == RoleWorker }

// State is the lifecycle position of one sandbox as the control plane records
// it. Provisioning, running, stopped, and failed mirror the states already
// persisted by the placement schema; deleting is the durable intent recorded
// before cascade delete starts, so a crash mid-delete resumes instead of
// leaking.
type State string

const (
	// StateProvisioning means a row exists and the provider call is in flight.
	StateProvisioning State = "provisioning"
	// StateRunning means the provider reports a started sandbox.
	StateRunning State = "running"
	// StateStopped means the sandbox exists but is not executing.
	StateStopped State = "stopped"
	// StateFailed means provisioning failed or the sandbox vanished from the
	// provider while the control plane expected it to exist.
	StateFailed State = "failed"
	// StateDeleting means delete was requested and must be driven to
	// completion, by the caller or by the reconciler.
	StateDeleting State = "deleting"
)

// Valid reports whether a state is one this package writes.
func (s State) Valid() bool {
	switch s {
	case StateProvisioning, StateRunning, StateStopped, StateFailed, StateDeleting:
		return true
	default:
		return false
	}
}

// Terminal reports whether a state means the sandbox is on its way out and
// should not be counted against a live quota.
func (s State) Terminal() bool { return s == StateDeleting }

// Ref identifies one sandbox placement. Every field is required, including
// SessionID for a coordinator: giving the coordinator its own session id keeps
// the placement key uniform (workspace, session), keeps provider labels
// uniform, and lets a workspace be re-coordinated under a new id without
// colliding with the row being torn down.
//
// UserID is the workspace owner and exists only for per-user quota accounting;
// authorization is never derived from it here.
type Ref struct {
	OrgID       string
	WorkspaceID string
	SessionID   string
	UserID      string
	Role        Role
}

// Validate rejects a partially populated ref.
func (r Ref) Validate() error {
	missing := make([]string, 0, 4)
	if strings.TrimSpace(r.OrgID) == "" {
		missing = append(missing, "organization")
	}
	if strings.TrimSpace(r.WorkspaceID) == "" {
		missing = append(missing, "workspace")
	}
	if strings.TrimSpace(r.SessionID) == "" {
		missing = append(missing, "session")
	}
	if strings.TrimSpace(r.UserID) == "" {
		missing = append(missing, "user")
	}
	if len(missing) > 0 {
		return fmt.Errorf("%w: sandbox reference is missing %s", ErrInvalid, strings.Join(missing, ", "))
	}
	if !r.Role.Valid() {
		return fmt.Errorf("%w: unknown sandbox role %q", ErrInvalid, r.Role)
	}
	return nil
}

// Normalize trims the ref's identifiers so a stray space cannot mint a second
// placement for the same logical session.
func (r Ref) Normalize() Ref {
	return Ref{
		OrgID:       strings.TrimSpace(r.OrgID),
		WorkspaceID: strings.TrimSpace(r.WorkspaceID),
		SessionID:   strings.TrimSpace(r.SessionID),
		UserID:      strings.TrimSpace(r.UserID),
		Role:        Role(strings.ToLower(strings.TrimSpace(string(r.Role)))),
	}
}

// String renders a ref for logs. It contains no credential material.
func (r Ref) String() string {
	return fmt.Sprintf("%s/%s/%s(%s)", r.OrgID, r.WorkspaceID, r.SessionID, r.Role)
}

// Label keys stamped on every AO-managed sandbox. Discovery, reconciliation,
// and leak cleanup all key off these; a sandbox missing any of them cannot be
// attributed to a tenant and is therefore treated as a leak.
const (
	// LabelManaged marks a sandbox as created by an AO control plane.
	LabelManaged = "ao.managed"
	// LabelDeployment names WHICH control plane owns it, so a staging deploy
	// sharing a provider account with production cannot reap production's
	// sandboxes.
	LabelDeployment = "ao.deployment"
	// LabelOrg, LabelWorkspace, and LabelSession attribute the sandbox.
	LabelOrg       = "ao.org"
	LabelWorkspace = "ao.workspace"
	LabelSession   = "ao.session"
	// LabelRole records the sandbox class.
	LabelRole = "ao.role"
	// LabelRuntimeID links the sandbox back to its control-plane row, which is
	// what makes orphan detection exact rather than heuristic.
	LabelRuntimeID = "ao.runtime"
)

// requiredLabels is the set every managed sandbox must carry. Cleanup treats a
// sandbox missing any of them as unattributable.
var requiredLabels = []string{
	LabelManaged, LabelDeployment, LabelOrg, LabelWorkspace, LabelSession, LabelRole, LabelRuntimeID,
}

// Labels builds the provider label set for one placement.
func Labels(deployment string, ref Ref, runtimeID string) map[string]string {
	return map[string]string{
		LabelManaged:    "true",
		LabelDeployment: strings.TrimSpace(deployment),
		LabelOrg:        ref.OrgID,
		LabelWorkspace:  ref.WorkspaceID,
		LabelSession:    ref.SessionID,
		LabelRole:       string(ref.Role),
		LabelRuntimeID:  runtimeID,
	}
}

// Attribution is what cleanup recovers from a sandbox's labels.
type Attribution struct {
	Deployment  string
	OrgID       string
	WorkspaceID string
	SessionID   string
	Role        Role
	RuntimeID   string
}

// Attribute reads a sandbox's AO labels. ok is false when any required label
// is missing or empty, which is the definition of an unattributable sandbox.
func Attribute(labels map[string]string) (Attribution, bool) {
	for _, key := range requiredLabels {
		if strings.TrimSpace(labels[key]) == "" {
			return Attribution{}, false
		}
	}
	if !strings.EqualFold(strings.TrimSpace(labels[LabelManaged]), "true") {
		return Attribution{}, false
	}
	role := Role(strings.ToLower(strings.TrimSpace(labels[LabelRole])))
	if !role.Valid() {
		return Attribution{}, false
	}
	return Attribution{
		Deployment:  strings.TrimSpace(labels[LabelDeployment]),
		OrgID:       strings.TrimSpace(labels[LabelOrg]),
		WorkspaceID: strings.TrimSpace(labels[LabelWorkspace]),
		SessionID:   strings.TrimSpace(labels[LabelSession]),
		Role:        role,
		RuntimeID:   strings.TrimSpace(labels[LabelRuntimeID]),
	}, true
}

// Record is one durable placement row. It carries no secret: capabilities live
// in the capability store and provider credentials live in configuration.
type Record struct {
	ID          string
	OrgID       string
	WorkspaceID string
	SessionID   string
	UserID      string
	Role        Role
	// ProviderID is the sandbox id at the provider. It is empty between the
	// row insert and a successful create.
	ProviderID string
	// State is what the control plane last observed.
	State State
	// DesiredState is what the control plane wants. The reconciler drives
	// State towards it; only StateRunning and StateStopped are meaningful
	// targets, and StateDeleting as an intent is carried by State itself.
	DesiredState State
	// Error is the last human-readable failure, empty on success.
	Error string
	// Generation guards concurrent writers. Every save must present the
	// generation it read and the store increments it.
	Generation int64
	// LastHeartbeatAt is the last authenticated sandbox check-in. Idle reaping
	// keys off it, so a sandbox that stops checking in is eventually stopped.
	LastHeartbeatAt time.Time
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

// Ref reconstructs the placement key of a record.
func (r Record) Ref() Ref {
	return Ref{
		OrgID:       r.OrgID,
		WorkspaceID: r.WorkspaceID,
		SessionID:   r.SessionID,
		UserID:      r.UserID,
		Role:        r.Role,
	}
}

// SortRecords orders records oldest first so reconciliation output is stable
// and callers do not depend on a store's iteration order. Exported for store
// adapters that cannot push the ordering into a query.
func SortRecords(records []Record) {
	sort.SliceStable(records, func(i, j int) bool {
		if records[i].CreatedAt.Equal(records[j].CreatedAt) {
			return records[i].ID < records[j].ID
		}
		return records[i].CreatedAt.Before(records[j].CreatedAt)
	})
}
