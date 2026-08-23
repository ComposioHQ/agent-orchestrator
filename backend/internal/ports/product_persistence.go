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

// AppSettings is the durable user-preference snapshot shared by both storage
// adapters and the settings service.
type AppSettings struct {
	DefaultSessionMode domain.SessionMode
	UpdatedAt          time.Time
}

// SettingsStore persists daemon-side preferences.
type SettingsStore interface {
	GetAppSettings(context.Context) (AppSettings, error)
	SetDefaultSessionMode(context.Context, domain.SessionMode, time.Time) error
}

// PRFactsReader supplies the persisted SCM facts consumed by session status,
// PR summaries, review delivery, notification reconciliation, and actions.
type PRFactsReader interface {
	GetPR(context.Context, string) (domain.PullRequest, bool, error)
	GetDisplayPRFactsForSession(context.Context, domain.SessionID) (domain.PRFacts, bool, error)
	ListPRFactsForSession(context.Context, domain.SessionID) ([]domain.PRFacts, error)
	ListPRsBySession(context.Context, domain.SessionID) ([]domain.PullRequest, error)
	ListChecks(context.Context, string) ([]domain.PullRequestCheck, error)
	ListPRReviews(context.Context, string) ([]domain.PullRequestReview, error)
	ListPRReviewThreads(context.Context, string) ([]domain.PullRequestReviewThread, error)
	ListPRComments(context.Context, string) ([]domain.PullRequestComment, error)
	GetPRLastNudgeSignature(context.Context, string) (string, error)
	UpdatePRLastNudgeSignature(context.Context, string, string) error
}

// PRFactsWriter combines the existing observation and claim contracts. Writes
// remain transactional so their change-event hook commits with the facts.
type PRFactsWriter interface {
	PRWriter
	SCMWriter
	PRClaimer
}

// PRActionStore is the persistence surface used to validate and record PR
// actions without coupling the action service to a concrete database.
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
