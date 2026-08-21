package session

import (
	"context"
	"fmt"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func (s *Service) reviewSnapshot(ctx context.Context, rec domain.SessionRecord, prs []domain.PRFacts) (domain.SessionReviewSnapshot, error) {
	runs, err := s.store.ListReviewRunsBySession(ctx, rec.ID)
	if err != nil {
		return domain.SessionReviewSnapshot{}, fmt.Errorf("list review runs for %s: %w", rec.ID, err)
	}
	snapshot := domain.SessionReviewSnapshot{
		AutoReviewEnabled: rec.AutoReviewEnabled,
		AutoInjectReview:  rec.AutoInjectReview,
		AutoInjectCI:      rec.AutoInjectCI,
		PRs:               make([]domain.SessionPRReviewSnapshot, 0, len(prs)),
	}
	for _, pr := range prs {
		prSnapshot := domain.SessionPRReviewSnapshot{PR: pr}
		prSnapshot.ReviewRuns = reviewRunsForPR(runs, pr)

		reviews, err := s.store.ListPRReviews(ctx, pr.URL)
		if err != nil {
			return domain.SessionReviewSnapshot{}, fmt.Errorf("list PR reviews for %s: %w", pr.URL, err)
		}
		comments, err := s.store.ListPRComments(ctx, pr.URL)
		if err != nil {
			return domain.SessionReviewSnapshot{}, fmt.Errorf("list PR comments for %s: %w", pr.URL, err)
		}

		aoReviewIDs := make(map[string]struct{}, len(prSnapshot.ReviewRuns))
		for _, run := range prSnapshot.ReviewRuns {
			if run.GithubReviewID != "" {
				aoReviewIDs[run.GithubReviewID] = struct{}{}
			}
		}
		for _, review := range reviews {
			if pr.HeadSHA != "" && review.TargetSHA != "" && !strings.EqualFold(review.TargetSHA, pr.HeadSHA) {
				continue
			}
			if _, ok := aoReviewIDs[review.ID]; ok {
				prSnapshot.AOReviewCount++
				continue
			}
			prSnapshot.ExternalReviewCount++
		}
		for _, comment := range comments {
			if comment.AutoInjectReview {
				prSnapshot.AOCommentCount++
				continue
			}
			prSnapshot.ExternalCommentCount++
		}
		snapshot.PRs = append(snapshot.PRs, prSnapshot)
	}
	return snapshot, nil
}

func reviewRunsForPR(runs []domain.ReviewRun, pr domain.PRFacts) []domain.ReviewRunFacts {
	out := make([]domain.ReviewRunFacts, 0)
	for _, run := range runs {
		if !reviewRunMatchesPR(run, pr) {
			continue
		}
		out = append(out, domain.ReviewRunFacts{
			ID:               run.ID,
			ReviewID:         run.ReviewID,
			SessionID:        run.SessionID,
			PRURL:            run.PRURL,
			TargetSHA:        run.TargetSHA,
			Status:           run.Status,
			Verdict:          run.Verdict,
			TriggerSource:    run.TriggerSource,
			GithubReviewID:   run.GithubReviewID,
			AutoInjectReview: run.AutoInjectReview,
		})
	}
	return out
}

func reviewRunMatchesPR(run domain.ReviewRun, pr domain.PRFacts) bool {
	if run.PRURL != pr.URL {
		return false
	}
	return sameSHA(run.TargetSHA, pr.HeadSHA)
}

func sameSHA(a, b string) bool {
	switch {
	case a == "" || b == "":
		return a == b
	default:
		return strings.EqualFold(a, b)
	}
}
