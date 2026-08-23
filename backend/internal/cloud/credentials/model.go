// Package credentials owns provider-neutral credential custody for AO Cloud.
// Plaintext exists only inside a bounded delivery callback and is never a
// persistence, logging, command-line, environment, or public API value.
package credentials

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"strings"
	"time"
)

const (
	// ProviderClaudeCode is the canonical provider wire value. "claude" is
	// intentionally not accepted as an alias.
	ProviderClaudeCode Provider = "claude-code"

	// OperationCredentialLoad is kept local until the capability owner adds it
	// to the central operation registry and worker grant template.
	OperationCredentialLoad Operation = "harness.credential.load"

	// RoleWorker is the only sandbox role permitted to load a harness credential.
	RoleWorker = "worker"

	// MaxCredentialBytes bounds one plaintext credential.
	MaxCredentialBytes = 64 << 10
	// MaxCredentialNameBytes bounds a display name.
	MaxCredentialNameBytes = 128
	// MaxProviderBytes bounds provider wire values.
	MaxProviderBytes = 32
	// MaxMetadataBytes bounds redacted JSON metadata.
	MaxMetadataBytes = 4 << 10
	// MaxIdempotencyKeyBytes bounds a caller retry key.
	MaxIdempotencyKeyBytes = 128
	// MaxReceiptBytes bounds an opaque harness acknowledgement receipt.
	MaxReceiptBytes = 256
	// MaxSecretFiles bounds one remote delivery file set.
	MaxSecretFiles = 4
	// MaxDeliveryBytes bounds aggregate transient file bytes.
	MaxDeliveryBytes = 64 << 10
	// MaxConcurrentDeliveries bounds process-local delivery work.
	MaxConcurrentDeliveries = 8
	// MaxInflightPerSandbox bounds durable concurrent sandbox loads.
	MaxInflightPerSandbox = 2
	// MaxInflightPerUser bounds durable concurrent user loads.
	MaxInflightPerUser = 8
	// MaxInflightPerOrg bounds durable concurrent organization loads.
	MaxInflightPerOrg = 64
	// MaxStoredBytesPerSandbox bounds aggregate inflight sandbox size metadata.
	MaxStoredBytesPerSandbox = 64 << 10
	// MaxStoredBytesPerUser bounds aggregate live user credential size metadata.
	MaxStoredBytesPerUser = 1 << 20
	// MaxStoredBytesPerOrg bounds aggregate live organization credential size metadata.
	MaxStoredBytesPerOrg = 32 << 20
)

var (
	// ErrInvalid reports malformed or unsupported credential input.
	ErrInvalid = errors.New("invalid credential request")
	// ErrNotAuthorized reports a capability or durable scope mismatch.
	ErrNotAuthorized = errors.New("credential operation not authorized")
	// ErrNotFound reports an absent credential.
	ErrNotFound = errors.New("credential not found")
	// ErrConflict reports an optimistic version or uniqueness conflict.
	ErrConflict = errors.New("credential conflict")
	// ErrRevoked reports an operation attempted on revoked material.
	ErrRevoked = errors.New("credential revoked")
	// ErrKMSUnavailable reports missing, invalid, or failed KMS configuration.
	ErrKMSUnavailable = errors.New("credential KMS unavailable")
	// ErrDeliveryFailed reports a redacted remote delivery failure.
	ErrDeliveryFailed = errors.New("credential delivery failed")
	// ErrLoadNotAcknowledged reports a missing or invalid harness receipt.
	ErrLoadNotAcknowledged = errors.New("harness did not acknowledge credential load")
	// ErrDeliveryInFlight reports a live duplicate delivery lease.
	ErrDeliveryInFlight = errors.New("credential delivery already in flight")
	// ErrLimitExceeded reports a byte or concurrency quota violation.
	ErrLimitExceeded = errors.New("credential limit exceeded")
)

// Provider is a canonical harness provider wire value.
type Provider string

// Operation is vault-local capability operation vocabulary pending central integration.
type Operation string

// ParseProvider accepts only canonical, bounded provider wire values.
func ParseProvider(value string) (Provider, error) {
	provider := Provider(strings.TrimSpace(value))
	if string(provider) != value || len(provider) == 0 || len(provider) > MaxProviderBytes || provider != ProviderClaudeCode {
		return "", fmt.Errorf("%w: unsupported provider", ErrInvalid)
	}
	return provider, nil
}

// CapabilityScope is a vault-local mirror of the facts a central capability
// verifier must supply. Keeping the operation vocabulary here avoids editing
// the shared capability registry before the integration owner is ready.
type CapabilityScope struct {
	OrgID       string
	WorkspaceID string
	SessionID   string
	Role        string
	Operations  []Operation
}

// VerifiedCapability contains only output from a capability verifier. Raw
// bearer material is deliberately absent.
type VerifiedCapability struct {
	GrantID string
	Scope   CapabilityScope
}

func (v VerifiedCapability) permitsCredentialLoad() bool {
	if !validIdentifier(v.GrantID) || !validIdentifier(v.Scope.OrgID) ||
		!validIdentifier(v.Scope.WorkspaceID) ||
		!validIdentifier(v.Scope.SessionID) || v.Scope.Role != RoleWorker {
		return false
	}
	for _, operation := range v.Scope.Operations {
		if operation == OperationCredentialLoad {
			return true
		}
	}
	return false
}

// DeliveryLookup can only be constructed from verified capability output. The
// store must join these fields to durable capability, runtime, workspace, and
// organization rows; no sandbox id is accepted from the caller.
type DeliveryLookup struct {
	grantID        string
	orgID          string
	workspaceID    string
	sessionID      string
	role           string
	provider       Provider
	idempotencyKey string
}

// NewDeliveryLookup derives an opaque SQL lookup exclusively from verified capability facts.
func NewDeliveryLookup(verified VerifiedCapability, provider Provider, idempotencyKey string) (DeliveryLookup, error) {
	if !verified.permitsCredentialLoad() || provider != ProviderClaudeCode || !validBounded(idempotencyKey, MaxIdempotencyKeyBytes) {
		return DeliveryLookup{}, ErrNotAuthorized
	}
	return DeliveryLookup{
		grantID: verified.GrantID, orgID: verified.Scope.OrgID,
		workspaceID: verified.Scope.WorkspaceID, sessionID: verified.Scope.SessionID,
		role: verified.Scope.Role, provider: provider, idempotencyKey: idempotencyKey,
	}, nil
}

// GrantID returns the verified central capability grant id.
func (l DeliveryLookup) GrantID() string { return l.grantID }

// OrgID returns the capability-derived organization id.
func (l DeliveryLookup) OrgID() string { return l.orgID }

// WorkspaceID returns the capability-derived workspace id.
func (l DeliveryLookup) WorkspaceID() string { return l.workspaceID }

// SessionID returns the capability-derived worker session id.
func (l DeliveryLookup) SessionID() string { return l.sessionID }

// Role returns the capability-derived sandbox role.
func (l DeliveryLookup) Role() string { return l.role }

// Provider returns the canonical requested harness provider.
func (l DeliveryLookup) Provider() Provider { return l.provider }

// IdempotencyKey returns the bounded caller retry key.
func (l DeliveryLookup) IdempotencyKey() string { return l.idempotencyKey }

func (l DeliveryLookup) valid() bool {
	return validIdentifier(l.grantID) && validIdentifier(l.orgID) &&
		validIdentifier(l.workspaceID) && validIdentifier(l.sessionID) && l.role == RoleWorker &&
		l.provider == ProviderClaudeCode && validBounded(l.idempotencyKey, MaxIdempotencyKeyBytes)
}

// EncryptedMaterial is the only credential representation persistence may
// receive. Its fields are ciphertext-only but are still redacted everywhere.
type EncryptedMaterial struct {
	Ciphertext       []byte
	EncryptedDataKey []byte
	Nonce            []byte
	KeyID            string
}

func (EncryptedMaterial) String() string { return "<redacted credential material>" }

// LogValue implements slog.LogValuer with unconditional redaction.
func (EncryptedMaterial) LogValue() slog.Value {
	return slog.StringValue("<redacted credential material>")
}

// MarshalJSON prevents ciphertext from becoming an accidental download surface.
func (EncryptedMaterial) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		Redacted bool `json:"redacted"`
	}{Redacted: true})
}

// CredentialRecord is one ciphertext-only durable credential version.
type CredentialRecord struct {
	ID             string
	OrgID          string
	OwnerUserID    string
	Name           string
	Provider       Provider
	Metadata       json.RawMessage
	Material       EncryptedMaterial
	PlaintextBytes int64
	Version        int64
	CreatedAt      time.Time
	UpdatedAt      time.Time
	RevokedAt      time.Time
}

// Metadata is safe to expose to authenticated callers.
type Metadata struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Provider  Provider        `json:"provider"`
	Metadata  json.RawMessage `json:"metadata,omitempty"`
	Version   int64           `json:"version"`
	CreatedAt time.Time       `json:"createdAt"`
	UpdatedAt time.Time       `json:"updatedAt"`
	RevokedAt time.Time       `json:"revokedAt,omitempty"`
}

// DeliveryState is the durable idempotent delivery state.
type DeliveryState string

const (
	// DeliveryClaimed means one caller owns the active delivery lease.
	DeliveryClaimed DeliveryState = "claimed"
	// DeliveryLoaded means the harness acknowledgement is durable.
	DeliveryLoaded DeliveryState = "loaded"
)

// DeliveryClaim is produced only by the durable store after its authorization
// join and quota checks. SandboxID is never accepted by Deliver.
type DeliveryClaim struct {
	ID              string
	Lookup          DeliveryLookup
	SandboxID       string
	Credential      CredentialRecord
	State           DeliveryState
	Acknowledgement LoadAcknowledgement
}

func (c DeliveryClaim) valid() bool {
	return validIdentifier(c.ID) && c.Lookup.valid() && validIdentifier(c.SandboxID) &&
		validIdentifier(c.Credential.ID) && c.Credential.OrgID == c.Lookup.orgID &&
		validIdentifier(c.Credential.OwnerUserID) && c.Credential.Provider == c.Lookup.provider &&
		c.Credential.Version > 0 && c.Credential.PlaintextBytes > 0 && c.Credential.PlaintextBytes <= MaxCredentialBytes &&
		c.revocationValid() && (c.State == DeliveryClaimed || c.State == DeliveryLoaded)
}

func (c DeliveryClaim) revocationValid() bool { return c.Credential.RevokedAt.IsZero() }

// SecretFile is one transient owner-only path and bounded mutable content buffer.
type SecretFile struct {
	Path    string
	Mode    fs.FileMode
	Content []byte
}

func (SecretFile) String() string { return "<redacted secret file>" }

// LogValue implements slog.LogValuer with unconditional redaction.
func (SecretFile) LogValue() slog.Value { return slog.StringValue("<redacted secret file>") }

// LoadRequest is consumed by a REMOTE sink. Implementations must never write
// these paths on the control-plane host.
type LoadRequest struct {
	SandboxID      string
	IdempotencyKey string
	Provider       Provider
	Files          []SecretFile
}

// LoadAcknowledgement is an explicit harness-loaded receipt. Loaded alone is
// insufficient: the sink must echo the key/provider, provide a non-zero load
// time, and return a bounded opaque harness receipt.
type LoadAcknowledgement struct {
	IdempotencyKey string
	Provider       Provider
	Loaded         bool
	LoadedAt       time.Time
	HarnessReceipt string
}

func (a LoadAcknowledgement) validFor(lookup DeliveryLookup) bool {
	return a.Loaded && a.IdempotencyKey == lookup.idempotencyKey && a.Provider == lookup.provider &&
		!a.LoadedAt.IsZero() && validBounded(a.HarnessReceipt, MaxReceiptBytes)
}

// FailureCode is a bounded, non-sensitive delivery failure category.
type FailureCode string

const (
	// FailureValidation records locally rejected credential material.
	FailureValidation FailureCode = "validation"
	// FailureLoad records a remote transport failure.
	FailureLoad FailureCode = "load"
	// FailureNoAck records a missing or invalid explicit receipt.
	FailureNoAck FailureCode = "missing_ack"
	// FailureCancelled records cancellation or timeout.
	FailureCancelled FailureCode = "cancelled"
	// FailureAudit records failure to durably acknowledge a load.
	FailureAudit FailureCode = "audit"
)

// DeliveryLimits bounds memory, concurrency, and durable inflight claims.
type DeliveryLimits struct {
	MaxItemBytes       int
	MaxAggregateBytes  int
	MaxConcurrent      int
	MaxInflightSandbox int
	MaxInflightUser    int
	MaxInflightOrg     int
	PurgeTimeout       time.Duration
}

// DefaultDeliveryLimits returns the maximum production vault delivery bounds.
func DefaultDeliveryLimits() DeliveryLimits {
	return DeliveryLimits{
		MaxItemBytes: MaxCredentialBytes, MaxAggregateBytes: MaxDeliveryBytes,
		MaxConcurrent: MaxConcurrentDeliveries, MaxInflightSandbox: MaxInflightPerSandbox,
		MaxInflightUser: MaxInflightPerUser, MaxInflightOrg: MaxInflightPerOrg,
		PurgeTimeout: 5 * time.Second,
	}
}

func (l DeliveryLimits) valid() bool {
	return l.MaxItemBytes > 0 && l.MaxItemBytes <= MaxCredentialBytes &&
		l.MaxAggregateBytes > 0 && l.MaxAggregateBytes <= MaxDeliveryBytes &&
		l.MaxConcurrent > 0 && l.MaxConcurrent <= MaxConcurrentDeliveries &&
		l.MaxInflightSandbox > 0 && l.MaxInflightSandbox <= MaxInflightPerSandbox &&
		l.MaxInflightUser > 0 && l.MaxInflightUser <= MaxInflightPerUser &&
		l.MaxInflightOrg > 0 && l.MaxInflightOrg <= MaxInflightPerOrg &&
		l.PurgeTimeout > 0 && l.PurgeTimeout <= 30*time.Second
}

// SecretFileSink is a provider-neutral REMOTE transport boundary. Load must
// return only after the target harness consumed the credential and generated
// the acknowledgement. Purge must be remote and idempotent.
type SecretFileSink interface {
	LoadCredential(context.Context, LoadRequest) (LoadAcknowledgement, error)
	PurgeCredential(context.Context, string, string, []string) error
}

// DeliveryStore owns authorization joins, durable idempotency, inflight quota
// checks, and exactly-once security audit transitions.
type DeliveryStore interface {
	ClaimDelivery(context.Context, DeliveryLookup, DeliveryLimits) (DeliveryClaim, error)
	AcknowledgeDelivery(context.Context, string, LoadAcknowledgement) error
	RecordDeliveryPurge(context.Context, string) error
	RecordDeliveryFailure(context.Context, string, FailureCode) error
}

// PlaintextOpener is the narrow envelope boundary. It has no general decrypt
// result; plaintext is valid only during consume and must be zeroed before
// Open returns, including when consume fails or the context is cancelled.
type PlaintextOpener interface {
	Open(context.Context, CredentialRecord, func([]byte) error) error
}

func validIdentifier(value string) bool { return validBounded(value, 256) }
func validBounded(value string, maximum int) bool {
	trimmed := strings.TrimSpace(value)
	return trimmed == value && value != "" && len(value) <= maximum && !strings.ContainsRune(value, '\x00')
}
