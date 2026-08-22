package contract

import "time"

// KanbanColumn is the derived delivery-lifecycle placement of a session. It
// answers where the session sits between first commit and merge, and who owns
// the next step. It is independent of the display SessionStatus and is never
// persisted.
type KanbanColumn string

// KanbanColumn values shown as board lanes by AO clients.
const (
	KanbanBuilding    KanbanColumn = "building"
	KanbanValidating  KanbanColumn = "validating"
	KanbanNeedsReview KanbanColumn = "needs_review"
	KanbanReady       KanbanColumn = "ready"
	KanbanArchive     KanbanColumn = "archive"
)

// KanbanSessionFacts are the session-level durable facts the column reducer
// reads: whether the runtime is gone, and which follow-up loops AO drives on
// the session's behalf.
type KanbanSessionFacts struct {
	IsTerminated     bool
	AutoReview       bool
	AutoInjectReview bool
	AutoInjectCI     bool
}

// KanbanReviewRunFacts summarize AO's own review passes against one PR's
// current head commit. Passes recorded for an earlier head are excluded before
// this struct is built, so a stale run can never decide the column.
type KanbanReviewRunFacts struct {
	// Present reports that AO recorded at least one pass for the current head.
	Present bool
	// Running reports that a pass for the current head is still in flight.
	Running bool
	// ChangesRequested reports that a pass for the current head asked the
	// worker for changes.
	ChangesRequested bool
}

// KanbanExternalReviewFacts are the provider review verdicts on one PR that AO
// did not author. AO's own provider reviews are matched by review id and
// excluded, because the aggregate ReviewDecision mixes both sources and cannot
// tell who owns the next step.
type KanbanExternalReviewFacts struct {
	Approved         bool
	ChangesRequested bool
}

// KanbanPRFacts are the per-PR facts the column reducer reads.
type KanbanPRFacts struct {
	URL            string
	Draft          bool
	Merged         bool
	Closed         bool
	CI             CIState
	Review         ReviewDecision
	Mergeability   Mergeability
	UpdatedAt      time.Time
	ReviewRun      KanbanReviewRunFacts
	ExternalReview KanbanExternalReviewFacts
}

// DeriveKanbanColumn derives one board placement for a session from its
// durable facts. A terminated session always archives; a session with no PR is
// still building; otherwise the representative PR decides.
func DeriveKanbanColumn(session KanbanSessionFacts, prs []KanbanPRFacts) KanbanColumn {
	if session.IsTerminated {
		return KanbanArchive
	}
	if len(prs) == 0 {
		return KanbanBuilding
	}
	// A terminal PR must not hide a live one that still needs validation or
	// human review; merged/closed placements count only once nothing is live.
	pool := liveKanbanPRs(prs)
	if len(pool) == 0 {
		pool = prs
	}

	column := KanbanColumn("")
	var chosen KanbanPRFacts
	for _, pr := range pool {
		candidate := derivePRKanbanColumn(session, pr)
		if column == "" || outranksKanban(candidate, pr, column, chosen) {
			column, chosen = candidate, pr
		}
	}
	return column
}

func derivePRKanbanColumn(session KanbanSessionFacts, pr KanbanPRFacts) KanbanColumn {
	switch {
	case pr.Draft:
		return KanbanValidating
	case pr.Merged || pr.Closed:
		return KanbanReady
	case externallyApproved(pr) || pr.Mergeability == MergeMergeable:
		return KanbanReady
	case aoOwnsNextStep(session, pr):
		return KanbanValidating
	// A head commit AO has not reviewed yet is a validation cycle AO will run
	// itself, so the PR is not waiting on a person.
	case session.AutoReview && !pr.ReviewRun.Present:
		return KanbanValidating
	default:
		return KanbanNeedsReview
	}
}

// externallyApproved requires both the provider's aggregate decision (which
// honors dismissed reviews) and a surviving approval AO did not author.
func externallyApproved(pr KanbanPRFacts) bool {
	return pr.Review == ReviewApproved && pr.ExternalReview.Approved
}

// aoOwnsNextStep reports whether AO itself drives the PR's next step: its
// review pass on the current head is still running, it is addressing review
// feedback, or it is fixing failing CI.
func aoOwnsNextStep(session KanbanSessionFacts, pr KanbanPRFacts) bool {
	if pr.ReviewRun.Running {
		return true
	}
	if session.AutoInjectReview && (pr.ReviewRun.ChangesRequested || pr.ExternalReview.ChangesRequested) {
		return true
	}
	return session.AutoInjectCI && pr.CI == CIFailing
}

func liveKanbanPRs(prs []KanbanPRFacts) []KanbanPRFacts {
	live := make([]KanbanPRFacts, 0, len(prs))
	for _, pr := range prs {
		if !pr.Merged && !pr.Closed {
			live = append(live, pr)
		}
	}
	return live
}

// outranksKanban picks the more actionable of two placements, breaking ties on
// the most recently updated PR and finally on URL so the board never flickers
// between equally ranked PRs.
func outranksKanban(candidate KanbanColumn, pr KanbanPRFacts, current KanbanColumn, chosen KanbanPRFacts) bool {
	if kanbanPriority(candidate) != kanbanPriority(current) {
		return kanbanPriority(candidate) < kanbanPriority(current)
	}
	if !pr.UpdatedAt.Equal(chosen.UpdatedAt) {
		return pr.UpdatedAt.After(chosen.UpdatedAt)
	}
	return pr.URL < chosen.URL
}

func kanbanPriority(column KanbanColumn) int {
	switch column {
	case KanbanReady:
		return 0
	case KanbanNeedsReview:
		return 1
	case KanbanValidating:
		return 2
	default:
		return 3
	}
}
