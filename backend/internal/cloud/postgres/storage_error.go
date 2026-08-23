package postgres

import (
	"errors"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// normalizeStorageError preserves the cloud store's established sentinels and
// additionally exposes the provider-neutral storage vocabulary required by the
// shared SQLite/PostgreSQL conformance contract. Keeping this product-store
// wrapper separate avoids coupling shared runtime-role validation to this
// feature slice.
func normalizeStorageError(err error) error {
	err = normalizeError(err)
	switch {
	case errors.Is(err, ErrNotFound):
		return errors.Join(err, ports.ErrStorageNotFound)
	case errors.Is(err, ErrConflict):
		return errors.Join(err, ports.ErrStorageConflict)
	case errors.Is(err, ErrInvalid):
		return errors.Join(err, ports.ErrStorageInvalid)
	default:
		return err
	}
}
