// Package credentials owns encrypted coding-harness credential custody and
// the single authorized path by which plaintext may reach a remote sandbox.
package credentials

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/capability"
)

// Provider identifies the coding harness that consumes a credential.
type Provider string

const (
	// ProviderClaude is the Claude Code credential provider.
	ProviderClaude Provider = "claude"
)

var (
	ErrInvalid        = errors.New("invalid harness credential request")
	ErrNotAuthorized  = errors.New("harness credential delivery not authorized")
	ErrKMSUnavailable = errors.New("credential KMS unavailable")
)

// EncryptedMaterial is the only credential representation persistence may
// receive. Ciphertext and the wrapped data key are deliberately redacted from
// JSON, fmt, and structured logs even though neither is plaintext.
type EncryptedMaterial struct {
	Ciphertext       []byte
	EncryptedDataKey []byte
	Nonce            []byte
	KeyID            string
}

func (EncryptedMaterial) String() string { return "<encrypted credential>" }

// LogValue prevents slog from reflecting encrypted byte fields.
func (EncryptedMaterial) LogValue() slog.Value { return slog.StringValue("<encrypted credential>") }

// MarshalJSON prevents an internal store record from becoming an accidental
// ciphertext download surface when passed to an HTTP encoder.
func (EncryptedMaterial) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		Redacted bool `json:"redacted"`
	}{Redacted: true})
}

// Metadata is safe for authenticated status responses. It contains neither
// plaintext nor encrypted material.
type Metadata struct {
	ID        string    `json:"id"`
	Provider  Provider  `json:"provider"`
	Version   int64     `json:"version"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	RevokedAt time.Time `json:"revokedAt,omitempty"`
}

// BootstrapLookup contains only identity already verified from the bearer
// capability. Its fields are intentionally opaque and never decoded from user
// input. Store implementations must join GrantID and Scope to the durable
// capability/runtime/workspace/org relationships before returning a record.
type BootstrapLookup struct {
	grantID  string
	scope    capability.Scope
	provider Provider
}

func bootstrapLookup(verified capability.Verified, provider Provider) (BootstrapLookup, error) {
	if strings.TrimSpace(verified.ID) == "" || verified.Scope.Role != capability.RoleWorker || !verified.Scope.Allows(capability.OpHarnessCredentialBootstrap) {
		return BootstrapLookup{}, ErrNotAuthorized
	}
	normalized, err := verified.Scope.Normalize()
	if err != nil || normalized.Role != capability.RoleWorker || !normalized.Allows(capability.OpHarnessCredentialBootstrap) {
		return BootstrapLookup{}, ErrNotAuthorized
	}
	return BootstrapLookup{grantID: verified.ID, scope: normalized, provider: provider}, nil
}

// GrantID is the verified capability grant id used by the SQL authorization join.
func (a BootstrapLookup) GrantID() string { return a.grantID }

// Scope returns a defensive copy of the capability-derived scope.
func (a BootstrapLookup) Scope() capability.Scope {
	scope := a.scope
	scope.Operations = append([]capability.Operation(nil), a.scope.Operations...)
	return scope
}

// Provider is the requested harness credential provider.
func (a BootstrapLookup) Provider() Provider { return a.provider }

func (a BootstrapLookup) valid() bool {
	return a.grantID != "" && a.provider != "" && a.scope.Role == capability.RoleWorker && a.scope.Allows(capability.OpHarnessCredentialBootstrap)
}

// BootstrapRecord is returned only after the store has proven the capability
// and runtime relationships. SandboxID comes from that relationship, never
// from an HTTP body or query parameter.
type BootstrapRecord struct {
	CredentialID string
	Provider     Provider
	Version      int64
	OrgID        string
	WorkspaceID  string
	SessionID    string
	Role         string
	RuntimeID    string
	SandboxID    string
	Material     EncryptedMaterial
}

// BootstrapAuthorizationScope is the proof consumed by delivery. Its opaque
// fields are populated only after a verified capability lookup matches an
// actual durable runtime placement; it cannot be populated from request ids.
type BootstrapAuthorizationScope struct {
	lookup    BootstrapLookup
	runtimeID string
	sandboxID string
}

func authorizeBootstrapScope(lookup BootstrapLookup, record BootstrapRecord) (BootstrapAuthorizationScope, error) {
	if !lookup.valid() ||
		strings.TrimSpace(record.CredentialID) == "" ||
		strings.TrimSpace(record.RuntimeID) == "" ||
		strings.TrimSpace(record.SandboxID) == "" ||
		record.Provider != lookup.provider ||
		record.OrgID != lookup.scope.OrgID ||
		record.WorkspaceID != lookup.scope.WorkspaceID ||
		record.SessionID != lookup.scope.SessionID ||
		record.Role != lookup.scope.Role {
		return BootstrapAuthorizationScope{}, ErrNotAuthorized
	}
	return BootstrapAuthorizationScope{lookup: lookup, runtimeID: record.RuntimeID, sandboxID: record.SandboxID}, nil
}

// RuntimeID is the placement row proven by the store authorization join.
func (a BootstrapAuthorizationScope) RuntimeID() string { return a.runtimeID }

// SandboxID is the provider sandbox proven by the store authorization join.
func (a BootstrapAuthorizationScope) SandboxID() string { return a.sandboxID }

func (a BootstrapAuthorizationScope) valid() bool {
	return a.lookup.valid() && a.runtimeID != "" && a.sandboxID != ""
}

// BootstrapEvent is an immutable security audit event.
type BootstrapEvent string

const (
	EventMaterialized   BootstrapEvent = "credential.materialized"
	EventPurged         BootstrapEvent = "credential.purged"
	EventDeliveryFailed BootstrapEvent = "credential.delivery_failed"
)

// BootstrapStore performs the authorization join and immutable audit writes.
// ResolveBootstrap must fail when any grant, org, workspace, session, runtime,
// sandbox, provider, revocation, or capability-scope relationship disagrees.
type BootstrapStore interface {
	ResolveBootstrap(context.Context, BootstrapLookup) (BootstrapRecord, error)
	RecordBootstrapEvent(context.Context, BootstrapRecord, BootstrapEvent) error
}

// EncryptionContext is authenticated by both KMS and the credential envelope.
// A data key or ciphertext moved to another tenant/provider/version will not
// decrypt under a different context.
type EncryptionContext struct {
	CredentialID string
	OrgID        string
	Provider     Provider
	Version      int64
}

func (c EncryptionContext) validate() error {
	if strings.TrimSpace(c.CredentialID) == "" || strings.TrimSpace(c.OrgID) == "" || strings.TrimSpace(string(c.Provider)) == "" || c.Version < 1 {
		return fmt.Errorf("%w: incomplete encryption context", ErrInvalid)
	}
	return nil
}

func (c EncryptionContext) additionalData() []byte {
	return []byte(fmt.Sprintf("ao-harness-credential-v1\x00%d:%s\x00%d:%s\x00%d:%s\x00%d",
		len(c.CredentialID), c.CredentialID,
		len(c.OrgID), c.OrgID,
		len(c.Provider), c.Provider,
		c.Version))
}

// DataKeyUnwrapper is the narrow AWS KMS boundary. It exposes only a data key
// bound to an already-authorized credential envelope; it does not expose a
// general credential decrypt operation. Implementations must fail closed when
// KMS configuration or connectivity is unavailable.
type DataKeyUnwrapper interface {
	UnwrapDataKey(context.Context, []byte, EncryptionContext) ([]byte, error)
}
