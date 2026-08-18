package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

// Get returns the current outcome control state. The boolean reports whether
// the active project exists; a project with no head exists but is unconfigured.
func (s *Store) Get(ctx context.Context, projectID domain.ProjectID) (domain.ProjectControl, bool, error) {
	tx, err := s.readDB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return domain.ProjectControl{}, false, fmt.Errorf("begin project control read for %s: %w", projectID, err)
	}
	defer func() { _ = tx.Rollback() }()

	state, exists, err := getProjectControlSnapshot(ctx, s.qr.WithTx(tx), projectID, nil)
	if err != nil {
		return domain.ProjectControl{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return domain.ProjectControl{}, false, fmt.Errorf("commit project control read for %s: %w", projectID, err)
	}
	return state, exists, nil
}

// SetOutcome applies one normalized outcome command in a single transaction.
// Idempotency is resolved before optimistic revision validation so a retry can
// always recover its original response even after later revisions committed.
func (s *Store) SetOutcome(ctx context.Context, projectID domain.ProjectID, mutation domain.SetOutcomeMutation) (domain.ProjectControl, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	var result domain.ProjectControl
	err := s.inTx(ctx, "set project outcome", func(q *gen.Queries) error {
		exists, err := q.ProjectControlProjectExists(ctx, projectID)
		if err != nil {
			return err
		}
		if !exists {
			return domain.ErrProjectNotFound
		}

		prior, err := q.GetProjectControlSetResult(ctx, gen.GetProjectControlSetResultParams{
			ProjectID: string(projectID), IdempotencyKey: mutation.IdempotencyKey,
		})
		if err == nil {
			if prior.RequestFingerprint != string(mutation.RequestFingerprint) {
				return domain.ErrProjectControlIdempotencyConflict
			}
			if err := json.Unmarshal([]byte(prior.ResultJson), &result); err != nil {
				return fmt.Errorf("decode stored SetOutcome result: %w", err)
			}
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}

		head, err := q.GetProjectControlHead(ctx, string(projectID))
		configured := err == nil
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		currentRevision := int64(0)
		if configured {
			currentRevision = head.Revision
		}
		if mutation.ExpectedRevision != currentRevision {
			return &domain.ProjectControlRevisionConflictError{CurrentRevision: currentRevision}
		}

		outcomeID := mutation.OutcomeIDCandidate
		if configured {
			outcomeID = domain.OutcomeID(head.RootOutcomeID)
		}
		if err := validateCriterionReferences(ctx, q, outcomeID, mutation.Criteria); err != nil {
			return err
		}

		nextRevision := currentRevision + 1
		if !configured {
			if err := q.InsertProjectControlHead(ctx, gen.InsertProjectControlHeadParams{
				ProjectID: string(projectID), RootOutcomeID: string(outcomeID),
				Revision: nextRevision, OwnerRole: string(domain.ProjectOwnerRole),
			}); err != nil {
				return err
			}
			if err := q.InsertProjectControlOutcome(ctx, gen.InsertProjectControlOutcomeParams{
				ID: string(outcomeID), ProjectID: string(projectID), Statement: mutation.Statement,
			}); err != nil {
				return err
			}
		} else {
			rows, err := q.UpdateProjectControlHeadRevision(ctx, gen.UpdateProjectControlHeadRevisionParams{
				Revision: nextRevision, ProjectID: string(projectID), Revision_2: currentRevision,
			})
			if err != nil {
				return err
			}
			if rows != 1 {
				latest, readErr := q.GetProjectControlHead(ctx, string(projectID))
				if readErr != nil {
					return readErr
				}
				return &domain.ProjectControlRevisionConflictError{CurrentRevision: latest.Revision}
			}
			rows, err = q.UpdateProjectControlOutcome(ctx, gen.UpdateProjectControlOutcomeParams{
				Statement: mutation.Statement, ID: string(outcomeID), ProjectID: string(projectID),
			})
			if err != nil {
				return err
			}
			if rows != 1 {
				return fmt.Errorf("root outcome %s is missing", outcomeID)
			}
		}

		// Slice one has no references to criteria, so replacement may physically
		// delete omissions. Keeping this operation behind one helper is the seam
		// for later retirement/supersession semantics that preserve the same IDs.
		if err := replaceProjectControlCriteria(ctx, q, outcomeID, mutation.Criteria); err != nil {
			return err
		}

		result = projectControlResult(projectID, outcomeID, nextRevision, mutation)
		encoded, err := json.Marshal(result)
		if err != nil {
			return fmt.Errorf("encode SetOutcome result: %w", err)
		}
		if err := q.InsertProjectControlSetResult(ctx, gen.InsertProjectControlSetResultParams{
			ProjectID: string(projectID), IdempotencyKey: mutation.IdempotencyKey,
			RequestFingerprint: string(mutation.RequestFingerprint), Revision: nextRevision,
			ResultJson: string(encoded),
		}); err != nil {
			return err
		}
		if err := q.InsertProjectControlEvent(ctx, gen.InsertProjectControlEventParams{
			ProjectID: string(projectID), OutcomeID: string(outcomeID), Revision: nextRevision,
			Payload: string(encoded), CreatedAt: mutation.OccurredAt,
		}); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return domain.ProjectControl{}, fmt.Errorf("set outcome for project %s: %w", projectID, err)
	}
	return result, nil
}

// getProjectControlSnapshot performs every aggregate read through q. afterHead
// is an internal deterministic concurrency-test seam; production passes nil.
func getProjectControlSnapshot(ctx context.Context, q *gen.Queries, projectID domain.ProjectID, afterHead func()) (domain.ProjectControl, bool, error) {
	exists, err := q.ProjectControlProjectExists(ctx, projectID)
	if err != nil {
		return domain.ProjectControl{}, false, fmt.Errorf("get project control project %s: %w", projectID, err)
	}
	if !exists {
		return domain.ProjectControl{}, false, nil
	}
	state, err := readProjectControl(ctx, q, projectID, afterHead)
	return state, true, err
}

func readProjectControl(ctx context.Context, q *gen.Queries, projectID domain.ProjectID, afterHead func()) (domain.ProjectControl, error) {
	head, err := q.GetProjectControlHead(ctx, string(projectID))
	if errors.Is(err, sql.ErrNoRows) {
		return domain.UnconfiguredProjectControl(projectID), nil
	}
	if err != nil {
		return domain.ProjectControl{}, fmt.Errorf("get project control head %s: %w", projectID, err)
	}
	if afterHead != nil {
		afterHead()
	}
	outcome, err := q.GetProjectControlOutcome(ctx, head.RootOutcomeID)
	if err != nil {
		return domain.ProjectControl{}, fmt.Errorf("get root outcome %s: %w", head.RootOutcomeID, err)
	}
	rows, err := q.ListProjectControlCriteria(ctx, head.RootOutcomeID)
	if err != nil {
		return domain.ProjectControl{}, fmt.Errorf("list criteria for %s: %w", head.RootOutcomeID, err)
	}
	criteria := make([]domain.AcceptanceCriterion, 0, len(rows))
	for _, row := range rows {
		criteria = append(criteria, domain.AcceptanceCriterion{
			ID: domain.AcceptanceCriterionID(row.ID), Statement: row.Statement,
			VerificationMethod: row.VerificationMethod, DisplayOrder: int(row.DisplayOrder),
		})
	}
	return domain.ProjectControl{
		ProjectID: projectID, Configured: true, Revision: head.Revision,
		Health: domain.ProjectControlHealthUnknown, Confidence: domain.ProjectControlConfidenceUnknown,
		Outcome: &domain.Outcome{ID: domain.OutcomeID(outcome.ID), Statement: outcome.Statement,
			Owner: domain.ProjectOwnerRole, Criteria: criteria},
	}, nil
}

func validateCriterionReferences(ctx context.Context, q *gen.Queries, outcomeID domain.OutcomeID, criteria []domain.AcceptanceCriterionMutation) error {
	for _, criterion := range criteria {
		row, err := q.GetProjectControlCriterion(ctx, string(criterion.ID))
		if criterion.Create {
			if err == nil || !errors.Is(err, sql.ErrNoRows) {
				if err != nil {
					return err
				}
				return domain.ErrAcceptanceCriterionIDUnknown
			}
			continue
		}
		if errors.Is(err, sql.ErrNoRows) || (err == nil && row.OutcomeID != string(outcomeID)) {
			return domain.ErrAcceptanceCriterionIDUnknown
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func replaceProjectControlCriteria(ctx context.Context, q *gen.Queries, outcomeID domain.OutcomeID, criteria []domain.AcceptanceCriterionMutation) error {
	if err := q.DeleteProjectControlCriteriaForOutcome(ctx, string(outcomeID)); err != nil {
		return err
	}
	for _, criterion := range criteria {
		if err := q.UpsertProjectControlCriterion(ctx, gen.UpsertProjectControlCriterionParams{
			ID: string(criterion.ID), OutcomeID: string(outcomeID), Statement: criterion.Statement,
			VerificationMethod: criterion.VerificationMethod, DisplayOrder: int64(criterion.DisplayOrder),
		}); err != nil {
			return err
		}
	}
	return nil
}

func projectControlResult(projectID domain.ProjectID, outcomeID domain.OutcomeID, revision int64, mutation domain.SetOutcomeMutation) domain.ProjectControl {
	criteria := make([]domain.AcceptanceCriterion, 0, len(mutation.Criteria))
	for _, criterion := range mutation.Criteria {
		criteria = append(criteria, domain.AcceptanceCriterion{
			ID: criterion.ID, Statement: criterion.Statement,
			VerificationMethod: criterion.VerificationMethod, DisplayOrder: criterion.DisplayOrder,
		})
	}
	return domain.ProjectControl{
		ProjectID: projectID, Configured: true, Revision: revision,
		Health: domain.ProjectControlHealthUnknown, Confidence: domain.ProjectControlConfidenceUnknown,
		Outcome: &domain.Outcome{ID: outcomeID, Statement: mutation.Statement,
			Owner: domain.ProjectOwnerRole, Criteria: criteria},
	}
}
