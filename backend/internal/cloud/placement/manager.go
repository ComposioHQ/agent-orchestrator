// Package placement owns provider-neutral workspace placement acceptance.
package placement

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
)

var (
	// ErrInvalid means the placement request is not safe to accept.
	ErrInvalid = errors.New("invalid workspace placement request")
	// ErrUnavailable means no asynchronous executor accepted the durable intent.
	ErrUnavailable = errors.New("workspace placement executor unavailable")
)

// Store persists placement intent before any compute provider is contacted.
type Store interface {
	CreateWorkspacePlacement(context.Context, domain.CreateWorkspacePlacement) (domain.WorkspacePlacement, bool, error)
	GetWorkspacePlacement(context.Context, string) (domain.WorkspacePlacement, error)
	ListWorkspacePlacements(context.Context, string, int) (domain.WorkspacePlacementPage, error)
	RequestWorkspacePlacementDelete(context.Context, string, string) (domain.WorkspacePlacement, bool, error)
	RequestWorkspacePlacementResume(context.Context, string, string) (domain.WorkspacePlacement, bool, error)
}

// Executor accepts a durable placement record for asynchronous convergence.
// Enqueue must return quickly; it must not perform provider provisioning in the
// HTTP request. Re-delivery is intentional and must be idempotent by placement
// ID and Intent.
type Executor interface {
	Enqueue(context.Context, domain.WorkspacePlacement) error
}

// Manager validates requests, persists intent, then wakes the executor.
type Manager struct {
	store    Store
	executor Executor
}

// New builds a placement manager around durable storage and an async executor.
func New(store Store, executor Executor) (*Manager, error) {
	if store == nil {
		return nil, errors.New("workspace placement store is required")
	}
	return &Manager{store: store, executor: executor}, nil
}

// Create durably accepts a placement and schedules convergence.
func (m *Manager) Create(ctx context.Context, input domain.CreateWorkspacePlacement) (domain.WorkspacePlacement, error) {
	input.DisplayName = strings.TrimSpace(input.DisplayName)
	input.RepositoryURL = strings.TrimSpace(input.RepositoryURL)
	input.DefaultBranch = strings.TrimSpace(input.DefaultBranch)
	input.IdempotencyKey = strings.TrimSpace(input.IdempotencyKey)
	if err := validateCreate(input); err != nil {
		return domain.WorkspacePlacement{}, err
	}
	record, _, err := m.store.CreateWorkspacePlacement(ctx, input)
	if err != nil {
		return domain.WorkspacePlacement{}, err
	}
	if record.State == domain.WorkspacePlacementPending {
		if err := m.enqueue(ctx, record); err != nil {
			return domain.WorkspacePlacement{}, err
		}
	}
	return record, nil
}

// Get returns one tenant-scoped placement.
func (m *Manager) Get(ctx context.Context, id string) (domain.WorkspacePlacement, error) {
	return m.store.GetWorkspacePlacement(ctx, strings.TrimSpace(id))
}

// List returns one stable page of tenant-scoped placements.
func (m *Manager) List(ctx context.Context, cursor string, limit int) (domain.WorkspacePlacementPage, error) {
	return m.store.ListWorkspacePlacements(ctx, strings.TrimSpace(cursor), limit)
}

// Delete accepts an idempotent delete intent and schedules convergence.
func (m *Manager) Delete(ctx context.Context, id, idempotencyKey string) (domain.WorkspacePlacement, error) {
	record, changed, err := m.store.RequestWorkspacePlacementDelete(ctx, strings.TrimSpace(id), strings.TrimSpace(idempotencyKey))
	if err != nil {
		return domain.WorkspacePlacement{}, err
	}
	if changed || record.State == domain.WorkspacePlacementPending {
		if err := m.enqueue(ctx, record); err != nil {
			return domain.WorkspacePlacement{}, err
		}
	}
	return record, nil
}

// Resume accepts an idempotent resume intent and schedules convergence.
func (m *Manager) Resume(ctx context.Context, id, idempotencyKey string) (domain.WorkspacePlacement, error) {
	record, changed, err := m.store.RequestWorkspacePlacementResume(ctx, strings.TrimSpace(id), strings.TrimSpace(idempotencyKey))
	if err != nil {
		return domain.WorkspacePlacement{}, err
	}
	if changed || record.State == domain.WorkspacePlacementPending {
		if err := m.enqueue(ctx, record); err != nil {
			return domain.WorkspacePlacement{}, err
		}
	}
	return record, nil
}

func (m *Manager) enqueue(ctx context.Context, record domain.WorkspacePlacement) error {
	if m.executor == nil {
		return ErrUnavailable
	}
	if err := m.executor.Enqueue(ctx, record); err != nil {
		return fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	return nil
}

func validateCreate(input domain.CreateWorkspacePlacement) error {
	if input.IdempotencyKey == "" || len(input.IdempotencyKey) > 200 ||
		len(input.DisplayName) > 200 || len(input.DefaultBranch) > 500 || len(input.RepositoryURL) > 4096 {
		return ErrInvalid
	}
	repository, err := url.Parse(input.RepositoryURL)
	if err != nil || repository.Host == "" || (repository.Scheme != "https" && repository.Scheme != "http") {
		return ErrInvalid
	}
	return nil
}
