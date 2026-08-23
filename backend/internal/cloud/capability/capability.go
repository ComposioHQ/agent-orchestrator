// Package capability issues, verifies, rotates, and revokes the opaque scoped
// credentials that authorize sandbox-to-control-plane traffic.
//
// The design copies AO's local launch-time browser capability
// (internal/service/browser.Authority, injected by session_manager's
// launchRuntimeEnv and recorded by persistBrowserCapabilityVerifier) and adds
// the two properties a hosted multi-tenant control plane needs:
//
//   - The credential is SCOPED. A grant names one organization, one workspace,
//     at most one session, and an explicit allow-list of operations. A worker
//     sandbox therefore cannot call coordinator operations or reach another
//     tenant's session even if its token leaks.
//   - The credential is REVOCABLE. Local AO can be stateless because a
//     capability dies with the daemon's session row; a hosted sandbox outlives
//     any single control-plane process, so grants live in a store and can be
//     revoked individually or by scope (which is what session and workspace
//     cascade delete does before it touches the provider).
//
// What is kept from the local pattern is the split-credential shape: the bearer
// secret is returned exactly once at issuance and is never persisted. What the
// store holds is a one-way verifier digest bound to the grant id AND to the
// grant's scope, so a verifier row copied onto another grant authorizes
// nothing.
package capability

import (
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Operation names one action a capability may authorize. Operations are
// validated against the registry below at issuance: a typo must fail loudly at
// issuance rather than silently minting a grant that authorizes nothing (or,
// with a wildcard scheme, everything).
type Operation string

const (
	// OpSandboxHeartbeat lets a sandbox report that it is alive and learn the
	// state the control plane wants it in.
	OpSandboxHeartbeat Operation = "sandbox.heartbeat"
	// OpSandboxReportState lets a sandbox publish its own observed state and
	// last error so the reconciler can converge without polling the provider.
	OpSandboxReportState Operation = "sandbox.report-state"
	// OpCapabilityRotate lets a holder exchange a live capability for a
	// successor with the same scope and the same absolute expiry.
	OpCapabilityRotate Operation = "capability.rotate"
	// OpSessionRead lets a worker read its own session's control-plane facts.
	OpSessionRead Operation = "session.read"
	// OpSessionWrite lets a worker publish progress for its own session.
	OpSessionWrite Operation = "session.write"
	// OpSessionSend lets either sandbox role send a message to the session in
	// its own scope. It never grants access to a sibling session.
	OpSessionSend Operation = "session.send"
	// OpWorkspaceRead lets a coordinator enumerate its workspace's sessions.
	OpWorkspaceRead Operation = "workspace.read"
	// OpWorkerProvision lets a coordinator ask the control plane to provision
	// worker sandboxes inside its own workspace. Workers never hold it.
	OpWorkerProvision Operation = "worker.provision"
	// OpPreviewSelf authorizes only the preview bound to the verified scope.
	OpPreviewSelf Operation = "preview.self"
	// OpBrowserSelf authorizes only the browser bound to the verified scope.
	OpBrowserSelf Operation = "browser.self"
	// OpActivitySelf authorizes only activity bound to the verified scope.
	OpActivitySelf Operation = "activity.self"
)

var knownOperations = map[Operation]struct{}{
	OpSandboxHeartbeat:   {},
	OpSandboxReportState: {},
	OpCapabilityRotate:   {},
	OpSessionRead:        {},
	OpSessionWrite:       {},
	OpSessionSend:        {},
	OpWorkspaceRead:      {},
	OpWorkerProvision:    {},
	OpPreviewSelf:        {},
	OpBrowserSelf:        {},
	OpActivitySelf:       {},
}

// OperationsForRole returns the least-privilege hosted sandbox profile. Both
// roles can read/send within their own session and use their own interactive
// surfaces; only a coordinator can enumerate a workspace or spawn workers.
func OperationsForRole(role string) ([]Operation, error) {
	shared := []Operation{
		OpSandboxHeartbeat, OpSandboxReportState, OpSessionRead, OpSessionSend,
		OpPreviewSelf, OpBrowserSelf, OpActivitySelf,
	}
	switch strings.ToLower(strings.TrimSpace(role)) {
	case RoleWorker:
		return shared, nil
	case RoleCoordinator:
		return append(shared, OpWorkspaceRead, OpWorkerProvision), nil
	default:
		return nil, fmt.Errorf("%w: unknown role %q", ErrInvalidScope, role)
	}
}

// Errors returned by the authority. Callers may distinguish them; the HTTP
// middleware maps every credential failure to 401 and ErrNotPermitted to 403.
var (
	// ErrInvalidToken means the presented string is not a well-formed AO
	// capability, names no live grant, or does not match the stored verifier.
	ErrInvalidToken = errors.New("invalid capability token")
	// ErrExpired means the grant existed but its absolute expiry has passed.
	ErrExpired = errors.New("capability token expired")
	// ErrRevoked means the grant was revoked, individually or by scope.
	ErrRevoked = errors.New("capability token revoked")
	// ErrNotPermitted means the grant is live but its scope does not allow the
	// requested operation.
	ErrNotPermitted = errors.New("capability token does not permit this operation")
	// ErrNotFound means no grant exists for an id. Stores return it; Verify
	// converts it to ErrInvalidToken so probing cannot enumerate grant ids.
	ErrNotFound = errors.New("capability grant not found")
	// ErrInvalidScope means a scope is missing a required field or names an
	// unknown operation.
	ErrInvalidScope = errors.New("invalid capability scope")
	// ErrConflict means a store already holds a grant with the same id.
	ErrConflict = errors.New("capability grant already exists")
)

// Scope is the authority a grant carries. OrgID and WorkspaceID are always
// required: there is no org-wide or account-wide compute capability, because
// the point of the split is that compromising one sandbox cannot reach
// another tenant or another workspace.
//
// SessionID may be empty only for a coordinator grant, which is workspace- and
// not session-scoped by construction. A worker grant must name its session.
type Scope struct {
	OrgID       string
	WorkspaceID string
	SessionID   string
	// Role is the sandbox class the grant was minted for ("coordinator" or
	// "worker"). It is part of the verifier binding, so a coordinator verifier
	// cannot be replayed against a worker row.
	Role string
	// Operations is the allow-list. Normalize sorts and dedupes it so the
	// verifier binding is stable regardless of caller ordering.
	Operations []Operation
}

// Roles recognized by a scope. They mirror the compute-plane sandbox roles but
// are plain strings here so the capability package stays independent of the
// runtime package (the runtime package consumes capability, not the reverse).
const (
	RoleCoordinator = "coordinator"
	RoleWorker      = "worker"
)

// Normalize validates a scope and returns its canonical form. Operations are
// sorted and deduped; unknown operations are rejected.
func (s Scope) Normalize() (Scope, error) {
	out := Scope{
		OrgID:       strings.TrimSpace(s.OrgID),
		WorkspaceID: strings.TrimSpace(s.WorkspaceID),
		SessionID:   strings.TrimSpace(s.SessionID),
		Role:        strings.ToLower(strings.TrimSpace(s.Role)),
	}
	if out.OrgID == "" || out.WorkspaceID == "" {
		return Scope{}, fmt.Errorf("%w: organization and workspace are required", ErrInvalidScope)
	}
	switch out.Role {
	case RoleCoordinator:
	case RoleWorker:
		if out.SessionID == "" {
			return Scope{}, fmt.Errorf("%w: a worker capability must name its session", ErrInvalidScope)
		}
	default:
		return Scope{}, fmt.Errorf("%w: unknown role %q", ErrInvalidScope, s.Role)
	}
	seen := make(map[Operation]struct{}, len(s.Operations))
	for _, op := range s.Operations {
		normalized := Operation(strings.ToLower(strings.TrimSpace(string(op))))
		if normalized == "" {
			continue
		}
		if _, ok := knownOperations[normalized]; !ok {
			return Scope{}, fmt.Errorf("%w: unknown operation %q", ErrInvalidScope, op)
		}
		seen[normalized] = struct{}{}
	}
	if len(seen) == 0 {
		return Scope{}, fmt.Errorf("%w: at least one operation is required", ErrInvalidScope)
	}
	out.Operations = make([]Operation, 0, len(seen))
	for op := range seen {
		out.Operations = append(out.Operations, op)
	}
	sort.Slice(out.Operations, func(i, j int) bool { return out.Operations[i] < out.Operations[j] })
	return out, nil
}

// Allows reports whether the scope permits one operation.
func (s Scope) Allows(op Operation) bool {
	op = Operation(strings.ToLower(strings.TrimSpace(string(op))))
	for _, candidate := range s.Operations {
		if candidate == op {
			return true
		}
	}
	return false
}

// fingerprint is the stable encoding of a normalized scope that the verifier
// digest binds to. Fields are length-prefixed so no combination of ids can be
// rearranged into the same byte string.
func (s Scope) fingerprint() string {
	parts := make([]string, 0, 4+len(s.Operations))
	parts = append(parts, s.OrgID, s.WorkspaceID, s.SessionID, s.Role)
	for _, op := range s.Operations {
		parts = append(parts, string(op))
	}
	var builder strings.Builder
	for _, part := range parts {
		fmt.Fprintf(&builder, "%d:%s\x00", len(part), part)
	}
	return builder.String()
}

// Grant is one issued capability. Token is populated only by Issue and Rotate
// and is never persisted or logged.
type Grant struct {
	ID        string
	Token     string
	Scope     Scope
	IssuedAt  time.Time
	ExpiresAt time.Time
}

// Record is the durable half of a grant. It holds no bearer secret: Verifier
// is a one-way digest over the grant id, the scope fingerprint, and the secret.
type Record struct {
	ID        string
	Scope     Scope
	Verifier  string
	IssuedAt  time.Time
	ExpiresAt time.Time
	// RevokedAt is zero while the grant is live.
	RevokedAt time.Time
	// RotatedToID names the successor when this grant was retired by Rotate.
	RotatedToID string
}

// Live reports whether a record may still authorize a request at now.
func (r Record) Live(now time.Time) error {
	if !r.RevokedAt.IsZero() && !now.Before(r.RevokedAt) {
		return ErrRevoked
	}
	if !r.ExpiresAt.IsZero() && !now.Before(r.ExpiresAt) {
		return ErrExpired
	}
	return nil
}

// Selector chooses grants for bulk revocation. OrgID is mandatory so a bug in
// a caller cannot revoke the whole fleet; empty WorkspaceID or SessionID mean
// "every workspace in the org" and "every session in the workspace".
type Selector struct {
	OrgID       string
	WorkspaceID string
	SessionID   string
}

// Matches reports whether a scope falls inside the selector.
func (s Selector) Matches(scope Scope) bool {
	if strings.TrimSpace(s.OrgID) == "" || scope.OrgID != strings.TrimSpace(s.OrgID) {
		return false
	}
	if workspace := strings.TrimSpace(s.WorkspaceID); workspace != "" && scope.WorkspaceID != workspace {
		return false
	}
	if session := strings.TrimSpace(s.SessionID); session != "" && scope.SessionID != session {
		return false
	}
	return true
}

// Validate rejects a selector with no organization.
func (s Selector) Validate() error {
	if strings.TrimSpace(s.OrgID) == "" {
		return fmt.Errorf("%w: revocation selector requires an organization", ErrInvalidScope)
	}
	if strings.TrimSpace(s.WorkspaceID) == "" && strings.TrimSpace(s.SessionID) != "" {
		return fmt.Errorf("%w: a session selector requires its workspace", ErrInvalidScope)
	}
	return nil
}

func digest(parts ...string) string {
	h := sha256.New()
	for _, part := range parts {
		_, _ = h.Write([]byte(strconv.Itoa(len(part))))
		_, _ = h.Write([]byte{':'})
		_, _ = h.Write([]byte(part))
		_, _ = h.Write([]byte{0})
	}
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}
