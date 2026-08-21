package domain

// ReviewRunFacts is the reducer-facing, read-only snapshot for one review run.
// It intentionally keeps only durable facts needed to tell current AO-owned
// review activity apart from external/human review state later on.
type ReviewRunFacts struct {
	ID               string              `json:"-"`
	ReviewID         string              `json:"-"`
	SessionID        SessionID           `json:"-"`
	PRURL            string              `json:"-"`
	TargetSHA        string              `json:"-"`
	Status           ReviewRunStatus     `json:"-"`
	Verdict          ReviewVerdict       `json:"-"`
	TriggerSource    ReviewTriggerSource `json:"-"`
	GithubReviewID   string              `json:"-"`
	AutoInjectReview bool                `json:"-"`
}

// SessionPRReviewSnapshot captures the durable current-head facts a future
// Kanban reducer needs for one PR owned by a session.
type SessionPRReviewSnapshot struct {
	PR               PRFacts              `json:"-"`
	ReviewRuns       []ReviewRunFacts     `json:"-"`
	AOReviews        []PullRequestReview  `json:"-"`
	ExternalReviews  []PullRequestReview  `json:"-"`
	AOComments       []PullRequestComment `json:"-"`
	ExternalComments []PullRequestComment `json:"-"`
}

// SessionReviewSnapshot is the read-only session-level snapshot used by the
// future review-aware Kanban reducer. It is intentionally not serialized.
type SessionReviewSnapshot struct {
	AutoReviewEnabled bool                      `json:"-"`
	AutoInjectReview  bool                      `json:"-"`
	AutoInjectCI      bool                      `json:"-"`
	PRs               []SessionPRReviewSnapshot `json:"-"`
}
