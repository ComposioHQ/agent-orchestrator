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

	RoleWorker = "worker"

	MaxCredentialBytes       = 64 << 10
	MaxCredentialNameBytes   = 128
	MaxProviderBytes         = 32
	MaxMetadataBytes         = 4 << 10
	MaxIdempotencyKeyBytes   = 128
	MaxReceiptBytes          = 256
	MaxSecretFiles           = 4
	MaxDeliveryBytes         = 64 << 10
	MaxConcurrentDeliveries  = 8
	MaxInflightPerSandbox    = 2
	MaxInflightPerUser       = 8
	MaxInflightPerOrg        = 64
	MaxStoredBytesPerSandbox = 64 << 10
	MaxStoredBytesPerUser    = 1 << 20
	MaxStoredBytesPerOrg     = 32 << 20
)

var (
	ErrInvalid             = errors.New("invalid credential request")
	ErrNotAuthorized       = errors.New("credential operation not authorized")
	ErrNotFound            = errors.New("credential not found")
	ErrConflict            = errors.New("credential conflict")
	ErrRevoked             = errors.New("credential revoked")
	ErrKMSUnavailable      = errors.New("credential KMS unavailable")
	ErrDeliveryFailed      = errors.New("credential delivery failed")
	ErrLoadNotAcknowledged = errors.New("harness did not acknowledge credential load")
	ErrDeliveryInFlight    = errors.New("credential delivery already in flight")
	ErrLimitExceeded       = errors.New("credential limit exceeded")
)

type Provider string
type Operation string

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

func (l DeliveryLookup) GrantID() string        { return l.grantID }
func (l DeliveryLookup) OrgID() string          { return l.orgID }
func (l DeliveryLookup) WorkspaceID() string    { return l.workspaceID }
func (l DeliveryLookup) SessionID() string      { return l.sessionID }
func (l DeliveryLookup) Role() string           { return l.role }
func (l DeliveryLookup) Provider() Provider     { return l.provider }
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
func (EncryptedMaterial) LogValue() slog.Value {
	return slog.StringValue("<redacted credential material>")
}
func (EncryptedMaterial) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		Redacted bool `json:"redacted"`
	}{Redacted: true})
}

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

type DeliveryState string

const (
	DeliveryClaimed DeliveryState = "claimed"
	DeliveryLoaded  DeliveryState = "loaded"
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
		c.RevocationValid() && (c.State == DeliveryClaimed || c.State == DeliveryLoaded)
}

func (c DeliveryClaim) RevocationValid() bool { return c.Credential.RevokedAt.IsZero() }

type SecretFile struct {
	Path    string
	Mode    fs.FileMode
	Content []byte
}

func (SecretFile) String() string       { return "<redacted secret file>" }
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

type FailureCode string

const (
	FailureValidation FailureCode = "validation"
	FailureLoad       FailureCode = "load"
	FailureNoAck      FailureCode = "missing_ack"
	FailureCancelled  FailureCode = "cancelled"
	FailureAudit      FailureCode = "audit"
)

type DeliveryLimits struct {
	MaxItemBytes       int
	MaxAggregateBytes  int
	MaxConcurrent      int
	MaxInflightSandbox int
	MaxInflightUser    int
	MaxInflightOrg     int
	PurgeTimeout       time.Duration
}

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
	return trimmed == value && len(value) > 0 && len(value) <= maximum && !strings.ContainsRune(value, '\x00')
}
