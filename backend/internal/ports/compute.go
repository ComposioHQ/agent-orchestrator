package ports

import "context"

// ComputeProvider is the provider-neutral outbound compute port. The type
// parameters keep provider contracts in this stable boundary without making
// ports depend on the cloud runtime package that supplies their domain types.
//
// Implementations must be safe for concurrent use. Start and Stop are
// idempotent transitions, Delete succeeds when the sandbox is already absent,
// and Create honors the request's idempotency key.
type ComputeProvider[CreateRequest, StartRequest, Sandbox, Selector any] interface {
	Create(ctx context.Context, request CreateRequest) (Sandbox, error)
	Get(ctx context.Context, id string) (Sandbox, error)
	Start(ctx context.Context, id string, request StartRequest) (Sandbox, error)
	Stop(ctx context.Context, id string) (Sandbox, error)
	Delete(ctx context.Context, id string) error
	List(ctx context.Context, selector Selector) ([]Sandbox, error)
}
