package ports

import (
	"context"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// SessionStore is the durable session registry: the rows the sidebar lists, the
// kanban groups, and the lifecycle manager advances.
//
// It stores facts, never display state. The user-facing status is derived at
// read time from activity state, termination, and PR facts, so there is no
// SetStatus here and there must never be one — a stored status is a second
// source of truth that drifts from the facts that produced it. PR, check,
// review, and comment observations belong to the SCM stores and are joined
// above this port, not inside it.
//
// Every mutator that targets an existing row reports ok=false rather than an
// error when nothing matched, because "the session was terminated while the
// request was in flight" is a race the API answers with 404, not 500.
type SessionStore interface {
	// GetSession returns the full record, or ok=false when absent.
	GetSession(ctx context.Context, id domain.SessionID) (domain.SessionRecord, bool, error)
	// ListSessions returns every session in a project, oldest first.
	ListSessions(ctx context.Context, project domain.ProjectID) ([]domain.SessionRecord, error)
	// ListAllSessions returns every session across every project, ordered by
	// project then creation order. It backs the unfiltered sidebar and kanban
	// reads, so it must be one query — never a fan-out per project.
	ListAllSessions(ctx context.Context) ([]domain.SessionRecord, error)

	// CreateSession assigns the per-project identity ("{project}-{n}") and
	// inserts the row, returning it with ID populated. Concurrent creates in
	// one project must not collide on n.
	CreateSession(ctx context.Context, rec domain.SessionRecord) (domain.SessionRecord, error)
	// UpdateSession writes the full mutable state of an existing session. The
	// id, project, per-project number, and creation time are immutable, so a
	// caller holding a stale record cannot move a session between projects.
	UpdateSession(ctx context.Context, rec domain.SessionRecord) error
	// UpdateSessionFromActivitySignal projects activity-derived metadata only
	// while the signal still belongs to the session's active launch. ok=false
	// means the signal was stale and nothing was written — the fence that stops
	// a dying generation from resurrecting the session that replaced it.
	UpdateSessionFromActivitySignal(ctx context.Context, rec domain.SessionRecord) (bool, error)
	// RecordSessionLatestUserPrompt persists the latest real user direction
	// without rewriting lifecycle state another writer may have advanced.
	RecordSessionLatestUserPrompt(ctx context.Context, id domain.SessionID, prompt string, updatedAt time.Time) (bool, error)
	// ClaimChatControllerGeneration makes generation the only Chat controller
	// allowed to project provider events for this session. It errors, rather
	// than reporting ok=false, when the session does not exist: an unclaimable
	// generation means the controller must not start at all.
	ClaimChatControllerGeneration(ctx context.Context, id domain.SessionID, generation string, updatedAt time.Time) error

	// RenameSession sets the user-facing display name.
	RenameSession(ctx context.Context, id domain.SessionID, displayName string, updatedAt time.Time) (bool, error)
	// SetSessionPinned pins or unpins a session for the sidebar. pinnedAt is
	// nil when unpinning.
	SetSessionPinned(ctx context.Context, id domain.SessionID, isPinned bool, pinnedAt *time.Time, updatedAt time.Time) (bool, error)
	// SetSessionPreviewURL persists the browser preview target and bumps the
	// preview revision. The revision advances even for an unchanged URL, so a
	// repeated preview request still reaches the client as a navigation.
	SetSessionPreviewURL(ctx context.Context, id domain.SessionID, previewURL string, updatedAt time.Time) (bool, error)
	// SetSessionTerminateOnPRMerge sets the merge-teardown lifecycle policy.
	SetSessionTerminateOnPRMerge(ctx context.Context, id domain.SessionID, terminate bool, updatedAt time.Time) (bool, error)
	// SetSessionAutoInjectReview toggles automatic review-comment injection.
	SetSessionAutoInjectReview(ctx context.Context, id domain.SessionID, autoInject bool, updatedAt time.Time) (bool, error)
	// SetSessionAutoInjectCI toggles automatic CI-failure injection.
	SetSessionAutoInjectCI(ctx context.Context, id domain.SessionID, autoInject bool, updatedAt time.Time) (bool, error)
	// SetSessionReviewerHarness overrides the project's reviewer for this
	// session. An empty harness delegates back to the project configuration.
	SetSessionReviewerHarness(ctx context.Context, id domain.SessionID, harness domain.ReviewerHarness, updatedAt time.Time) (bool, error)
	// SetSessionAutoReview toggles automatic PR review for this session.
	SetSessionAutoReview(ctx context.Context, id domain.SessionID, enabled bool, updatedAt time.Time) (bool, error)

	// DeleteSession removes a session row only while it is still in seed state:
	// no workspace, no runtime handle, no agent session id, no prompt, and not
	// terminated. Rows with observable spawn output are immutable, which is
	// what makes the no-resurrection guarantee hold. deleted=false means the
	// row was absent or had progressed past seed state; callers fall back to
	// marking the session terminated.
	DeleteSession(ctx context.Context, id domain.SessionID) (bool, error)
}
