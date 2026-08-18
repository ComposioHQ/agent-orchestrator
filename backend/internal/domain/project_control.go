package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

// OutcomeID identifies the single root outcome configured for a project.
type OutcomeID string

// AcceptanceCriterionID identifies one stable root-outcome criterion.
type AcceptanceCriterionID string

// ProjectControlOwnerRole is the fixed slice-one outcome owner vocabulary.
type ProjectControlOwnerRole string

// ProjectControlHealth is the deliberately limited slice-one health view.
type ProjectControlHealth string

// ProjectControlConfidence is the deliberately limited slice-one confidence view.
type ProjectControlConfidence string

// OutcomeRequestFingerprint binds an idempotency key to normalized SetOutcome input.
type OutcomeRequestFingerprint string

const (
	// ProjectOwnerRole is the only owner supported by slice one.
	ProjectOwnerRole ProjectControlOwnerRole = "role:project-owner"

	// ProjectControlHealthUnconfigured marks the absence of a durable head;
	ProjectControlHealthUnconfigured ProjectControlHealth = "unconfigured"
	// ProjectControlHealthUnknown is the only configured health in slice one.
	ProjectControlHealthUnknown ProjectControlHealth = "unknown"
	// ProjectControlConfidenceUnknown is the only confidence in slice one.
	ProjectControlConfidenceUnknown ProjectControlConfidence = "unknown"

	outcomeRequestFingerprintPrefix = "v1:"
)

// AcceptanceCriterion is one ordered, stable test of root-outcome acceptance.
type AcceptanceCriterion struct {
	ID                 AcceptanceCriterionID `json:"id"`
	Statement          string                `json:"statement"`
	VerificationMethod string                `json:"verificationMethod"`
	DisplayOrder       int                   `json:"displayOrder"`
}

// Outcome is the single project root outcome and its ordered criteria.
type Outcome struct {
	ID        OutcomeID               `json:"id"`
	Statement string                  `json:"statement"`
	Owner     ProjectControlOwnerRole `json:"owner" enum:"role:project-owner"`
	Criteria  []AcceptanceCriterion   `json:"criteria"`
}

// ProjectControl is the current durable outcome-control read model.
type ProjectControl struct {
	ProjectID  ProjectID                `json:"projectId"`
	Configured bool                     `json:"configured"`
	Revision   int64                    `json:"revision"`
	Health     ProjectControlHealth     `json:"health" enum:"unconfigured,unknown"`
	Confidence ProjectControlConfidence `json:"confidence" enum:"unknown"`
	Outcome    *Outcome                 `json:"outcome,omitempty"`
}

// UnconfiguredProjectControl returns the revision-zero view for a project with no head.
func UnconfiguredProjectControl(projectID ProjectID) ProjectControl {
	return ProjectControl{
		ProjectID: projectID, Health: ProjectControlHealthUnconfigured,
		Confidence: ProjectControlConfidenceUnknown,
	}
}

// AcceptanceCriterionInput creates a criterion when ID is empty or updates it when present.
type AcceptanceCriterionInput struct {
	ID                 AcceptanceCriterionID
	Statement          string
	VerificationMethod string
	DisplayOrder       int
}

// SetOutcomeInput replaces the root statement and authoritative criterion collection.
type SetOutcomeInput struct {
	ExpectedRevision int64
	IdempotencyKey   string
	Statement        string
	Criteria         []AcceptanceCriterionInput
}

// SetOutcomeMutation is the normalized, ID-resolved command passed across the
// service/store boundary. Create is deliberately criterion-specific: a future
// slice can change omission from deletion to retirement without changing a
// criterion's stable ID or the public SetOutcome input.
type SetOutcomeMutation struct {
	ExpectedRevision   int64
	IdempotencyKey     string
	RequestFingerprint OutcomeRequestFingerprint
	OutcomeIDCandidate OutcomeID
	Statement          string
	Criteria           []AcceptanceCriterionMutation
	OccurredAt         time.Time
}

// AcceptanceCriterionMutation is one normalized, ID-resolved criterion write.
type AcceptanceCriterionMutation struct {
	ID                 AcceptanceCriterionID
	Create             bool
	Statement          string
	VerificationMethod string
	DisplayOrder       int
}

// NormalizeSetOutcomeInput produces the single semantic representation used
// for validation, fingerprinting, and persistence. Criteria are ordered by
// display order because that order, not request slice position, is durable.
func NormalizeSetOutcomeInput(in SetOutcomeInput) (SetOutcomeInput, error) {
	in.IdempotencyKey = strings.TrimSpace(in.IdempotencyKey)
	in.Statement = strings.TrimSpace(in.Statement)
	if in.ExpectedRevision < 0 {
		return SetOutcomeInput{}, fmt.Errorf("expected revision must be non-negative")
	}
	if in.IdempotencyKey == "" {
		return SetOutcomeInput{}, fmt.Errorf("idempotency key is required")
	}
	if in.Statement == "" {
		return SetOutcomeInput{}, fmt.Errorf("outcome statement is required")
	}

	criteria := append([]AcceptanceCriterionInput(nil), in.Criteria...)
	seenIDs := make(map[AcceptanceCriterionID]struct{}, len(criteria))
	seenOrders := make(map[int]struct{}, len(criteria))
	for i := range criteria {
		criteria[i].ID = AcceptanceCriterionID(strings.TrimSpace(string(criteria[i].ID)))
		criteria[i].Statement = strings.TrimSpace(criteria[i].Statement)
		criteria[i].VerificationMethod = strings.TrimSpace(criteria[i].VerificationMethod)
		if criteria[i].Statement == "" {
			return SetOutcomeInput{}, fmt.Errorf("acceptance criterion statement is required")
		}
		if criteria[i].VerificationMethod == "" {
			return SetOutcomeInput{}, fmt.Errorf("acceptance criterion verification method is required")
		}
		if criteria[i].DisplayOrder < 0 {
			return SetOutcomeInput{}, fmt.Errorf("acceptance criterion display order must be non-negative")
		}
		if _, ok := seenOrders[criteria[i].DisplayOrder]; ok {
			return SetOutcomeInput{}, ErrDuplicateCriterionDisplayOrder
		}
		seenOrders[criteria[i].DisplayOrder] = struct{}{}
		if criteria[i].ID != "" {
			if _, ok := seenIDs[criteria[i].ID]; ok {
				return SetOutcomeInput{}, ErrDuplicateCriterionID
			}
			seenIDs[criteria[i].ID] = struct{}{}
		}
	}
	sort.Slice(criteria, func(i, j int) bool { return criteria[i].DisplayOrder < criteria[j].DisplayOrder })
	in.Criteria = criteria
	return in, nil
}

// ComputeOutcomeRequestFingerprint hashes normalized user-visible SetOutcome input.
func ComputeOutcomeRequestFingerprint(projectID ProjectID, in SetOutcomeInput) OutcomeRequestFingerprint {
	payload, _ := json.Marshal(struct {
		ProjectID        ProjectID                  `json:"projectId"`
		ExpectedRevision int64                      `json:"expectedRevision"`
		Statement        string                     `json:"statement"`
		Criteria         []AcceptanceCriterionInput `json:"criteria"`
	}{projectID, in.ExpectedRevision, in.Statement, in.Criteria})
	sum := sha256.Sum256(payload)
	return OutcomeRequestFingerprint(outcomeRequestFingerprintPrefix + hex.EncodeToString(sum[:]))
}

// ProjectControlRevisionConflictError reports an optimistic-concurrency mismatch.
type ProjectControlRevisionConflictError struct{ CurrentRevision int64 }

func (e *ProjectControlRevisionConflictError) Error() string {
	return fmt.Sprintf("project control revision conflict: current revision is %d", e.CurrentRevision)
}

var (
	// ErrProjectControlIdempotencyConflict rejects reuse for different normalized input.
	ErrProjectControlIdempotencyConflict = errors.New("domain: project control idempotency conflict")
	// ErrAcceptanceCriterionIDUnknown rejects unknown and cross-outcome criterion IDs.
	ErrAcceptanceCriterionIDUnknown = errors.New("domain: acceptance criterion id is unknown or belongs to another outcome")
	// ErrDuplicateCriterionID rejects repeated non-empty criterion IDs.
	ErrDuplicateCriterionID = errors.New("domain: duplicate acceptance criterion id")
	// ErrDuplicateCriterionDisplayOrder rejects repeated criterion display positions.
	ErrDuplicateCriterionDisplayOrder = errors.New("domain: duplicate acceptance criterion display order")
	// ErrProjectNotFound reports a missing or archived project registry row.
	ErrProjectNotFound = errors.New("domain: project not found")
)
