package capability

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

var (
	// ErrTicketNotFound deliberately covers unknown verifiers and scope
	// mismatches so callers cannot enumerate tickets.
	ErrTicketNotFound = errors.New("terminal ticket not found")
	// ErrTicketSpent means another consumer already atomically redeemed it.
	ErrTicketSpent = errors.New("terminal ticket already consumed")
	// ErrTicketExpired means the ticket passed its absolute expiry.
	ErrTicketExpired = errors.New("terminal ticket expired")
	// ErrTicketRevoked means its durable scope was retired before use.
	ErrTicketRevoked = errors.New("terminal ticket revoked")
)

// TerminalTicketScope binds a one-time terminal connection to one durable
// runtime handle and provider sandbox. Both values are checked at consume so
// a ticket cannot be replayed after placement replacement.
type TerminalTicketScope struct {
	OrgID       string
	WorkspaceID string
	SessionID   string
	// SandboxID is the durable runtime placement id exposed as the sandbox
	// handle. Provider ids never cross this authorization boundary.
	SandboxID string
	Role      string
}

// Validate rejects any wildcard ticket scope.
func (s TerminalTicketScope) Validate() error {
	if strings.TrimSpace(s.OrgID) == "" || strings.TrimSpace(s.WorkspaceID) == "" ||
		strings.TrimSpace(s.SessionID) == "" || strings.TrimSpace(s.SandboxID) == "" {
		return fmt.Errorf("%w: terminal ticket scope must name org, workspace, session, and sandbox handle", ErrInvalidScope)
	}
	if s.Role != RoleCoordinator && s.Role != RoleWorker {
		return fmt.Errorf("%w: unknown terminal ticket role %q", ErrInvalidScope, s.Role)
	}
	return nil
}

// TerminalTicket is the durable half of an opaque one-time credential.
// Verifier is a one-way digest of the bearer and is the only credential
// material persisted. The plaintext bearer is returned only by the issuer.
type TerminalTicket struct {
	ID       string
	Verifier []byte
	Scope    TerminalTicketScope
	// Scopes map directly to 181's online TicketGrant scopes
	// (terminal:read, terminal:operate, workspace:observe).
	Scopes     []string
	IssuedAt   time.Time
	ExpiresAt  time.Time
	ConsumedAt time.Time
	RevokedAt  time.Time
}

// TerminalTicketStore is the online atomic replay boundary. Production must
// provide a durable implementation; there is intentionally no in-memory
// implementation in this package.
type TerminalTicketStore interface {
	ports.ComputeTerminalTicketStore[TerminalTicket, TerminalTicketScope, Selector]
}
