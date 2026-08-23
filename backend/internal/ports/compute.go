package ports

import (
	"context"
	"time"
)

// ComputeProvider is the provider-neutral outbound compute port. The type
// parameters keep provider contracts in this stable boundary without making
// ports depend on the cloud runtime package that supplies their domain types.
//
// Implementations must be safe for concurrent use. Start and Stop are
// idempotent transitions, Delete succeeds when the sandbox is already absent,
// and Create honors the request's idempotency key. Adapters must purge every
// mutable secret/capability buffer before Create or Start returns on both
// success and failure.
type ComputeProvider[CreateRequest, StartRequest, Sandbox, Selector any] interface {
	Create(ctx context.Context, request CreateRequest) (Sandbox, error)
	Get(ctx context.Context, id string) (Sandbox, error)
	Start(ctx context.Context, id string, request StartRequest) (Sandbox, error)
	Stop(ctx context.Context, id string) (Sandbox, error)
	Delete(ctx context.Context, id string) error
	List(ctx context.Context, selector Selector) ([]Sandbox, error)
}

// ComputePlacementStore is the provider-neutral durable placement port.
// Ensure must evaluate quotas and insert the provisioning row in one atomic
// transaction. Save and Delete are generation-CAS operations; deleting rows
// are never resurrected. Implementations return the domain package's conflict
// and not-found sentinels so lifecycle retries can distinguish them.
type ComputePlacementStore[Ref, Quotas, Record, Filter any] interface {
	Ensure(ctx context.Context, ref Ref, quotas Quotas, now time.Time) (record Record, created bool, err error)
	Get(ctx context.Context, ref Ref) (Record, error)
	GetByID(ctx context.Context, id string) (Record, error)
	Save(ctx context.Context, record Record) (Record, error)
	Delete(ctx context.Context, id string, generation int64) error
	List(ctx context.Context, filter Filter) ([]Record, error)
}

// ComputeCapabilityStore persists capability liveness. Plaintext bearer
// material is never stored. Revoke and RevokeScope are idempotent and retain
// the first revocation instant; DeleteExpired is the only physical deletion.
type ComputeCapabilityStore[Record, Selector any] interface {
	Insert(ctx context.Context, record Record) error
	ByID(ctx context.Context, id string) (Record, error)
	Revoke(ctx context.Context, id string, at time.Time, rotatedToID string) error
	RevokeScope(ctx context.Context, selector Selector, at time.Time) (int, error)
	DeleteExpired(ctx context.Context, before time.Time) (int, error)
}

// ComputeTerminalTicketStore is the durable replay boundary for opaque,
// one-time terminal tickets. verifier is a one-way digest, never the bearer.
// Consume must verify scope, liveness, and unused state and mark the ticket
// consumed in one statement/transaction (normally UPDATE ... RETURNING).
// Exactly one concurrent consumer may succeed.
type ComputeTerminalTicketStore[Ticket, Scope, Selector any] interface {
	Insert(ctx context.Context, ticket Ticket) error
	Consume(ctx context.Context, verifier []byte, scope Scope, at time.Time) (Ticket, error)
	RevokeScope(ctx context.Context, selector Selector, at time.Time) (int, error)
	DeleteExpired(ctx context.Context, before time.Time) (int, error)
}
