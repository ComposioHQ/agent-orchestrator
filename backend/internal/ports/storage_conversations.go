package ports

import (
	"context"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// ConversationSnapshot is the durable read model for one conversation: the
// record itself plus the timeline entries, already ordered by sequence so the
// caller never sorts. OldestSequence and HasMoreBefore describe a bounded page;
// a full read leaves them zero and false.
type ConversationSnapshot struct {
	Conversation               domain.ConversationRecord
	Turns                      []domain.ConversationTurn
	Messages                   []domain.ConversationMessage
	Activities                 []domain.ConversationActivity
	BranchPoints               []domain.ConversationBranchPoint
	BranchedFromEarlierMessage bool
	OldestSequence             int64
	HasMoreBefore              bool
}

// ConversationReader is the durable read behind a Chat session's history. It is
// separate from ConversationStore because history must stay readable long after
// the agent process is gone — that is the point of persisting it — so the read
// path must not require whatever a live writer needs.
type ConversationReader interface {
	// LoadConversationSnapshot reads a whole conversation.
	LoadConversationSnapshot(ctx context.Context, conversationID string) (ConversationSnapshot, error)
	// LoadConversationSnapshotPage reads a bounded slice ending immediately
	// before beforeSequence; zero starts at the live edge. Messages and
	// activities share one sequence and are trimmed as a single page, so a
	// noisy command cannot crowd prose out of the window.
	LoadConversationSnapshotPage(ctx context.Context, conversationID string, beforeSequence, limit int64) (ConversationSnapshot, error)
}

// ConversationStore is the durable conversation surface a Chat controller
// writes through: one conversation per session, its branches, its turns, and
// the messages and activities projected from provider events.
//
// Two invariants shape the method set and cannot be relaxed by an
// implementation:
//
//   - Archive and projection are one write. ProjectProviderEvent records the
//     raw provider event and runs the caller's projection inside a single
//     transaction, so the archive can never disagree with the timeline derived
//     from it, and a redelivered event id is a no-op rather than a duplicate
//     entry.
//   - A stale generation cannot write. The generation the caller claimed is a
//     predicate on the write itself, not a check performed beforehand, so a
//     controller that is dying cannot mutate the session that replaced it.
//
// Missing conversations and turns are reported with the shared domain
// sentinels (domain.ErrNoConversation, domain.ErrNoConversationTurn) rather
// than engine-specific errors.
type ConversationStore interface {
	// CreateConversation registers the session's conversation. It is
	// idempotent: a session that already has one gets that record back.
	CreateConversation(ctx context.Context, id string, scope domain.ConversationScope, project domain.ProjectID, session domain.SessionID, now time.Time) (domain.ConversationRecord, error)
	// CreateProjectConversationWithContextReset rebinds a project-scoped
	// narrative to its replacement orchestrator and records the reset boundary
	// atomically when prior history exists.
	CreateProjectConversationWithContextReset(ctx context.Context, id string, project domain.ProjectID, session domain.SessionID, reset domain.ConversationActivity, now time.Time) (domain.ConversationRecord, error)
	// ConversationForSession returns the session's conversation, or
	// domain.ErrNoConversation when it has none.
	ConversationForSession(ctx context.Context, session domain.SessionID) (domain.ConversationRecord, error)
	// ClaimChatControllerGeneration makes generation the only controller
	// allowed to project events for this session.
	ClaimChatControllerGeneration(ctx context.Context, session domain.SessionID, generation string, now time.Time) error

	// ConversationBranch returns one branch of a conversation.
	ConversationBranch(ctx context.Context, conversationID, branchID string) (domain.ConversationBranch, error)
	// ConversationEditAnchor resolves where an edited turn re-roots the
	// timeline.
	ConversationEditAnchor(ctx context.Context, conversationID, replacedTurnID string) (domain.ConversationEditAnchor, error)
	// CreateAndActivateConversationBranch creates a branch and makes it the
	// active one in a single write, so a crash between the two cannot leave a
	// conversation pointing at a branch that does not exist.
	CreateAndActivateConversationBranch(ctx context.Context, sessionID domain.SessionID, branch domain.ConversationBranch, generation string, now time.Time) error
	// ActivateConversationBranch switches the conversation to an existing
	// branch and rebinds it to the provider conversation backing that branch.
	ActivateConversationBranch(ctx context.Context, sessionID domain.SessionID, conversationID, branchID, providerConversationID, generation string, now time.Time) error
	// UpdateConversationBranchReplacement records the turn that replaced the
	// branch's edited turn.
	UpdateConversationBranchReplacement(ctx context.Context, branchID, replacementTurnID string) error

	// AdoptProviderTurn binds an AO turn to a turn the provider started on its
	// own, so a resumed conversation does not grow a duplicate.
	AdoptProviderTurn(ctx context.Context, conversationID string, session domain.SessionID, generation, turnID, providerTurnID string, now time.Time) error
	// AppendImportedUserMessage replays a user message that came from the
	// provider's own history rather than from this AO client.
	AppendImportedUserMessage(ctx context.Context, conversationID, providerTurnID string, msg domain.ConversationMessage, now time.Time) error

	// AppendUserMessage records a user turn. ok=false means the generation was
	// stale and nothing was written.
	AppendUserMessage(ctx context.Context, conversationID string, session domain.SessionID, generation string, msg domain.ConversationMessage, turnID string, now time.Time) (bool, error)
	// BindTurnToProvider attaches the provider's turn id once it is known.
	BindTurnToProvider(ctx context.Context, turnID, providerTurnID string, now time.Time) error
	// SettleTurn finalises a turn identified by its provider id.
	SettleTurn(ctx context.Context, conversationID, providerTurnID string, state domain.TurnState, errMessage string, now time.Time) error
	// SettleTurnByID finalises a turn identified by its AO id, for turns the
	// provider never acknowledged.
	SettleTurnByID(ctx context.Context, turnID string, state domain.TurnState, errMessage string, now time.Time) error
	// SettleOrphanedTurns fails any turn left running when a controller ended.
	// A controller that stopped mid-turn is not evidence the work finished.
	SettleOrphanedTurns(ctx context.Context, session domain.SessionID, now time.Time) error
	// ListVisibleRunningTurnProviderIDs returns the provider turn ids still
	// running on the active branch.
	ListVisibleRunningTurnProviderIDs(ctx context.Context, conversationID string) ([]string, error)

	// SetConversationSettings replaces the conversation's agent settings.
	SetConversationSettings(ctx context.Context, conversationID string, settings domain.ConversationSettings, now time.Time) error

	// RecordUsage and RecordRateLimits store current state, not timeline
	// entries: each write replaces the last. The provider reports usage after
	// every tool call, so appending one entry per report would bury the
	// conversation it describes.
	RecordUsage(ctx context.Context, conversationID string, usage domain.ConversationUsage) error
	// RecordRateLimits replaces the conversation's latest rate-limit reading.
	RecordRateLimits(ctx context.Context, conversationID string, limits domain.ConversationRateLimits) error

	// NextQueuedTurn returns the oldest queued turn, if any.
	NextQueuedTurn(ctx context.Context, conversationID string) (domain.QueuedTurn, error)
	// ReserveQueuedTurnForPromotion claims a queued turn so exactly one
	// promoter can send it.
	ReserveQueuedTurnForPromotion(ctx context.Context, conversationID, turnID string, now time.Time) (domain.QueuedTurn, error)
	// ReleaseQueuedTurnPromotion returns a reserved turn to the queue when the
	// send did not happen.
	ReleaseQueuedTurnPromotion(ctx context.Context, conversationID, turnID string) error
	// CompleteQueuedTurnPromotion binds a promoted turn to the provider turn it
	// became and records the activity that carried it.
	CompleteQueuedTurnPromotion(ctx context.Context, conversationID, sourceTurnID, providerTurnID string, activity domain.ConversationActivity, now time.Time) error
	// CancelQueuedTurns cancels queued turns created at or before cutoff.
	CancelQueuedTurns(ctx context.Context, conversationID string, cutoff, now time.Time) error
	// CancelAllQueuedTurns cancels every queued turn.
	CancelAllQueuedTurns(ctx context.Context, conversationID string, now time.Time) error

	// TurnByID reads one turn, or domain.ErrNoConversationTurn.
	TurnByID(ctx context.Context, turnID string) (domain.ConversationTurn, error)
	// RollbackTurns removes the turn and everything after it, returning how
	// many turns went. The agent has forgotten them, so a timeline that still
	// showed them would describe a conversation the agent is not in.
	RollbackTurns(ctx context.Context, conversationID, turnID string, now time.Time) (int, error)

	// SetProviderTitle records the provider's title for the conversation.
	SetProviderTitle(ctx context.Context, conversationID, title string, now time.Time) error
	// ApplyProviderTitle adopts the provider title as the session display name
	// when the user has not named the session themselves.
	ApplyProviderTitle(ctx context.Context, conversationID string, session domain.SessionID, title string, now time.Time) (bool, error)

	// AppendAssistantDelta appends streamed assistant prose.
	AppendAssistantDelta(ctx context.Context, conversationID, providerItemID, providerTurnID, delta, messageID string, now time.Time) error
	// SettleAssistantMessage replaces the streamed prose with its final form.
	SettleAssistantMessage(ctx context.Context, conversationID, providerItemID, providerTurnID, text, messageID string, now time.Time) error

	// AppendCommandOutput appends output to a running command activity.
	AppendCommandOutput(ctx context.Context, conversationID, providerItemID, delta string, now time.Time) (bool, error)
	// SetTurnDiff records the working-tree diff a turn produced.
	SetTurnDiff(ctx context.Context, conversationID, providerTurnID string, diff domain.ConversationTurnDiff, now time.Time) (bool, error)

	// AppendActivityStreamedText appends provider prose belonging to an
	// activity: reasoning summaries, terminal keystrokes, tool progress.
	AppendActivityStreamedText(ctx context.Context, conversationID, providerItemID, delta string, now time.Time) (bool, error)
	// SettleActivityStreamedText replaces that streamed prose with its settled
	// form. It is two calls rather than one upsert because the deltas arrive
	// many times before the final text exists.
	SettleActivityStreamedText(ctx context.Context, conversationID, providerItemID, text string, now time.Time) (bool, error)

	// SetTurnPlan records the plan a turn is working from.
	SetTurnPlan(ctx context.Context, conversationID, providerTurnID string, plan domain.ConversationPlan) (bool, error)

	// RecordModelReroute, RecordAccount, RecordThreadState, and RecordMCPServers
	// are latest-wins provider state that belongs to the conversation rather
	// than to any one turn: each write replaces the last.
	RecordModelReroute(ctx context.Context, conversationID string, reroute domain.ConversationModelReroute) error
	// RecordAccount replaces the provider account the conversation runs under.
	RecordAccount(ctx context.Context, conversationID string, account domain.ConversationAccount, now time.Time) error
	// RecordThreadState replaces the provider's thread state.
	RecordThreadState(ctx context.Context, conversationID string, state domain.ConversationThreadState) error
	// RecordMCPServers replaces the conversation's MCP server set.
	RecordMCPServers(ctx context.Context, conversationID string, servers []domain.ConversationMCPServer) error

	// UpsertActivity records or updates one timeline activity.
	UpsertActivity(ctx context.Context, conversationID, providerTurnID string, activity domain.ConversationActivity, now time.Time) error
	// MarkCompacted records that the provider compacted the conversation.
	MarkCompacted(ctx context.Context, conversationID string, at time.Time) error
	// ResolveApproval settles a pending approval request.
	ResolveApproval(ctx context.Context, conversationID, requestID, detailJSON string, now time.Time) error
	// FailPendingApprovals fails approvals nobody can answer any more.
	FailPendingApprovals(ctx context.Context, conversationID string, now time.Time) error
	// FailPendingInputs fails input requests nobody can answer any more.
	FailPendingInputs(ctx context.Context, conversationID string, now time.Time) error

	// ProjectProviderEvent archives one provider event and runs project inside
	// the same transaction. ok=false means the event was a redelivery or
	// carried a stale generation, and project did not run.
	ProjectProviderEvent(ctx context.Context, conversationID string, session domain.SessionID, generation, providerEventID, method, payloadJSON string, now time.Time, project func(context.Context) error) (bool, error)
}
