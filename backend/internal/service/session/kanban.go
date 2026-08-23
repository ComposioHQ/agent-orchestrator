package session

import (
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/pkg/contract"
)

func deriveKanbanPresentation(
	rec domain.SessionRecord,
	prs []domain.PRFacts,
	runs []domain.CurrentHeadReviewRun,
	now time.Time,
	signalCapable bool,
) contract.KanbanPresentation {
	return contract.DeriveKanbanPresentation(
		toContractKanbanSessionFacts(rec, signalCapable),
		toContractKanbanPRFacts(prs, runs),
		now,
		noSignalGrace,
	)
}

func toContractKanbanSessionFacts(rec domain.SessionRecord, signalCapable bool) contract.KanbanSessionFacts {
	return contract.KanbanSessionFacts{
		SessionFacts:     toContractSessionFacts(rec, signalCapable),
		AutoReview:       rec.AutoReviewEnabled,
		AutoInjectReview: rec.AutoInjectReview,
		AutoInjectCI:     rec.AutoInjectCI,
	}
}

func toContractKanbanPRFacts(prs []domain.PRFacts, runs []domain.CurrentHeadReviewRun) []contract.KanbanPRFacts {
	byPR := make(map[string]contract.KanbanReviewRunFacts, len(runs))
	for _, run := range runs {
		facts := byPR[run.PRURL]
		facts.Present = true
		facts.Running = facts.Running || run.Status == domain.ReviewRunRunning
		facts.ChangesRequested = facts.ChangesRequested || run.Verdict == domain.VerdictChangesRequested
		facts.Outcome = facts.Outcome || run.Verdict.Valid()
		facts.Failed = facts.Failed || run.Status == domain.ReviewRunFailed
		facts.Cancelled = facts.Cancelled || run.Status == domain.ReviewRunCancelled
		byPR[run.PRURL] = facts
	}

	out := make([]contract.KanbanPRFacts, len(prs))
	for i, pr := range prs {
		out[i] = contract.KanbanPRFacts{
			URL:          pr.URL,
			Draft:        pr.Draft,
			Merged:       pr.Merged,
			Closed:       pr.Closed,
			CI:           currentHeadCI(pr),
			Review:       pr.Review,
			Mergeability: pr.Mergeability,
			UpdatedAt:    pr.UpdatedAt,
			ReviewRun:    byPR[pr.URL],
			ExternalReview: contract.KanbanExternalReviewFacts{
				Approved:         pr.ExternalApproved,
				ChangesRequested: pr.ExternalChangesRequested,
			},
		}
	}
	return out
}

// currentHeadCI reports a PR's aggregate CI state only while it describes the
// PR's current head commit. Once AO holds check rows for earlier commits and
// none for the head, the aggregate is about code that is no longer the PR, so
// the reducer reads an unknown state instead of a stale verdict.
func currentHeadCI(pr domain.PRFacts) contract.CIState {
	if pr.CIAtCurrentHead {
		return pr.CI
	}
	return contract.CIUnknown
}
