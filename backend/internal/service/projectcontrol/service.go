package projectcontrol

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// Manager is the controller-facing slice-one project-control contract.
type Manager interface {
	Get(ctx context.Context, projectID domain.ProjectID) (domain.ProjectControl, error)
	SetOutcome(ctx context.Context, projectID domain.ProjectID, input domain.SetOutcomeInput) (domain.ProjectControl, error)
}

// Service exposes only the slice-one Get and SetOutcome use cases.
type Service struct {
	store Store
	newID func() string
	clock func() time.Time
}

var _ Manager = (*Service)(nil)

// Deps supplies durable storage and deterministic test seams.
type Deps struct {
	Store Store
	NewID func() string
	Clock func() time.Time
}

// New returns a project-control service backed by store.
func New(store Store) *Service { return NewWithDeps(Deps{Store: store}) }

// NewWithDeps returns a project-control service with optional clock and ID seams.
func NewWithDeps(deps Deps) *Service {
	service := &Service{store: deps.Store, newID: deps.NewID, clock: deps.Clock}
	if service.newID == nil {
		service.newID = uuid.NewString
	}
	if service.clock == nil {
		service.clock = time.Now
	}
	return service
}

// Get returns configured state or the explicit unconfigured revision-zero view.
func (s *Service) Get(ctx context.Context, projectID domain.ProjectID) (domain.ProjectControl, error) {
	state, projectExists, err := s.store.Get(ctx, projectID)
	if err != nil {
		return domain.ProjectControl{}, err
	}
	if !projectExists {
		return domain.ProjectControl{}, domain.ErrProjectNotFound
	}
	return state, nil
}

// SetOutcome atomically replaces the root outcome at the expected project revision.
func (s *Service) SetOutcome(ctx context.Context, projectID domain.ProjectID, input domain.SetOutcomeInput) (domain.ProjectControl, error) {
	normalized, err := domain.NormalizeSetOutcomeInput(input)
	if err != nil {
		return domain.ProjectControl{}, err
	}

	mutation := domain.SetOutcomeMutation{
		ExpectedRevision:   normalized.ExpectedRevision,
		IdempotencyKey:     normalized.IdempotencyKey,
		RequestFingerprint: domain.ComputeOutcomeRequestFingerprint(projectID, normalized),
		OutcomeIDCandidate: domain.OutcomeID("outcome-" + s.newID()),
		Statement:          normalized.Statement,
		OccurredAt:         s.clock().UTC(),
		Criteria:           make([]domain.AcceptanceCriterionMutation, 0, len(normalized.Criteria)),
	}
	seenIDs := make(map[domain.AcceptanceCriterionID]struct{}, len(normalized.Criteria))
	for _, criterion := range normalized.Criteria {
		create := criterion.ID == ""
		id := criterion.ID
		if create {
			id = domain.AcceptanceCriterionID("criterion-" + s.newID())
		}
		if _, exists := seenIDs[id]; exists {
			return domain.ProjectControl{}, domain.ErrDuplicateCriterionID
		}
		seenIDs[id] = struct{}{}
		mutation.Criteria = append(mutation.Criteria, domain.AcceptanceCriterionMutation{
			ID: id, Create: create, Statement: criterion.Statement,
			VerificationMethod: criterion.VerificationMethod, DisplayOrder: criterion.DisplayOrder,
		})
	}
	return s.store.SetOutcome(ctx, projectID, mutation)
}
