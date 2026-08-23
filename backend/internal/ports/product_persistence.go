package ports

import (
	"context"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// NotificationReader is the notification service's persistence surface.
type NotificationReader interface {
	ListNotifications(context.Context, domain.NotificationListStatus, time.Time, string, int) ([]domain.NotificationRecord, error)
	CountUnreadNotifications(context.Context) (int64, error)
	CountUnresolvedNotifications(context.Context) (int64, error)
	MarkNotificationRead(context.Context, string) (domain.NotificationRecord, bool, error)
	MarkAllNotificationsRead(context.Context) (int64, error)
	MarkNotificationsRead(context.Context, []string) (int64, error)
}

// NotificationWriter is the lifecycle notification producer's persistence
// surface. Resolution methods return the changed rows for live publication.
type NotificationWriter interface {
	CreateNotification(context.Context, domain.NotificationRecord) (domain.NotificationRecord, bool, error)
	ResolveSessionNotifications(context.Context, domain.SessionID, domain.NotificationType, time.Time) ([]domain.NotificationRecord, error)
	ResolvePRNotifications(context.Context, string, domain.NotificationType, time.Time) ([]domain.NotificationRecord, error)
	ReconcileResolvedNotifications(context.Context, time.Time) ([]domain.NotificationRecord, error)
}

// NotificationStore is the complete notification persistence port.
type NotificationStore interface {
	NotificationReader
	NotificationWriter
}

// SettingsSnapshot is the durable user-preference snapshot shared by storage
// adapters and the settings service.
type SettingsSnapshot struct {
	DefaultSessionMode domain.SessionMode
	UpdatedAt          time.Time
}

// SettingsStore persists daemon-side preferences.
type SettingsStore interface {
	GetAppSettings(context.Context) (SettingsSnapshot, error)
	SetDefaultSessionMode(context.Context, domain.SessionMode, time.Time) error
}

// ReviewRunStore persists the complete lifecycle of AO-internal review passes.
// Database triggers own CDC for these canonical mutations; adapters must not
// emit review-run change events manually.
type ReviewRunStore interface {
	InsertReviewRun(context.Context, domain.ReviewRun) error
	UpdateReviewRunResult(context.Context, string, domain.ReviewRunStatus, domain.ReviewVerdict, string, string, bool) (bool, error)
	SupersedeStaleRunningReviewRuns(context.Context, domain.SessionID, string, string, string) (int64, error)
	CancelRunningReviewRunsBySession(context.Context, domain.SessionID, string) (int64, error)
	CancelRunningReviewRunsBySessionAndHarness(context.Context, domain.SessionID, domain.ReviewerHarness, string) (int64, error)
	MarkReviewRunDelivered(context.Context, string, time.Time) (bool, error)
	GetReviewRun(context.Context, string) (domain.ReviewRun, bool, error)
	GetReviewRunBySessionPRAndSHA(context.Context, domain.SessionID, string, string) (domain.ReviewRun, bool, error)
	GetReviewRunBySessionPRSHAAndHarness(context.Context, domain.SessionID, string, string, domain.ReviewerHarness) (domain.ReviewRun, bool, error)
	ListReviewRunsBySession(context.Context, domain.SessionID) ([]domain.ReviewRun, error)
	ListRunningReviewRunsBySession(context.Context, domain.SessionID) ([]domain.ReviewRun, error)
	ListReviewRunsByBatch(context.Context, domain.SessionID, string) ([]domain.ReviewRun, error)
}

// PRFactsReader supplies persisted SCM facts to session status, PR summaries,
// review delivery, notification reconciliation, and actions.
type PRFactsReader interface {
	GetPR(context.Context, string) (domain.PullRequest, bool, error)
	GetDisplayPRFactsForSession(context.Context, domain.SessionID) (domain.PRFacts, bool, error)
	ListPRFactsForSession(context.Context, domain.SessionID) ([]domain.PRFacts, error)
	ListPRsBySession(context.Context, domain.SessionID) ([]domain.PullRequest, error)
	ListChecks(context.Context, string) ([]domain.PullRequestCheck, error)
	ListPRReviews(context.Context, string) ([]domain.PullRequestReview, error)
	ListPRReviewThreads(context.Context, string) ([]domain.PullRequestReviewThread, error)
	ListPRComments(context.Context, string) ([]domain.PullRequestComment, error)
}

// PRFactsWriter combines the existing observation and claim contracts. The
// database's triggers own CDC for these canonical SQL mutations.
type PRFactsWriter interface {
	PRWriter
	SCMWriter
	PRClaimer
}

// PRActionStore validates and records PR actions without coupling the action
// service to a concrete database.
type PRActionStore interface {
	GetPR(context.Context, string) (domain.PullRequest, bool, error)
	MarkPRCommentResolved(context.Context, string, string) (bool, error)
}

// PRStore is the complete persisted SCM fact and action surface.
type PRStore interface {
	PRFactsReader
	PRFactsWriter
	PRActionStore
}
