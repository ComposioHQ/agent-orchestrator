package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	storageports "github.com/aoagents/agent-orchestrator/backend/internal/storage/ports"
)

// sessionColumns is the read projection shared by every session query. Get and
// the two list paths decode identically, so a column can never be present in
// one read model and silently absent from another.
const sessionColumns = `id, project_id, issue_id, kind, harness, reviewer_harness,
	auto_review_enabled, display_name, session_mode, activity_state, activity_last_at,
	first_signal_at, is_terminated, is_pinned, pinned_at, terminate_on_pr_merge,
	auto_inject_review, auto_inject_ci, cleanup_generation, branch, workspace_path,
	workspace_repo_path, diff_base_sha, diff_base_ref, runtime_handle_id,
	runtime_launch_id, agent_session_id, agent_session_id_launch_id, prompt,
	latest_user_prompt, latest_assistant_update, native_transcript_path, preview_url,
	preview_revision, browser_capability_verifier, provider_conversation_id,
	controller_generation, model, created_at, updated_at`

// GetSession returns one session, or ok=false when it does not exist for this
// tenant. A session belonging to another tenant is indistinguishable from one
// that never existed, which is the point.
func (s *Store) GetSession(ctx context.Context, id domain.SessionID) (domain.SessionRecord, bool, error) {
	var rec domain.SessionRecord
	found := false
	err := s.inTenantRead(ctx, func(tx pgx.Tx) error {
		row, err := scanSession(tx.QueryRow(ctx,
			`SELECT `+sessionColumns+` FROM ao_sessions WHERE id = $1`, id))
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		rec, found = row, true
		return nil
	})
	if err != nil {
		return domain.SessionRecord{}, false, fmt.Errorf("get session %s: %w", id, normalizeError(err))
	}
	return rec, found, nil
}

// ListSessions returns one project's sessions, oldest first.
func (s *Store) ListSessions(ctx context.Context, project domain.ProjectID) ([]domain.SessionRecord, error) {
	out, err := s.listSessions(ctx,
		`SELECT `+sessionColumns+` FROM ao_sessions WHERE project_id = $1 ORDER BY num`, project)
	if err != nil {
		return nil, fmt.Errorf("list sessions for %s: %w", project, err)
	}
	return out, nil
}

// ListAllSessions returns every session the tenant owns. The sidebar and the
// kanban board both read it on every refresh, so it is one indexed query over
// (org_id, project_id, num) rather than a fan-out per project.
func (s *Store) ListAllSessions(ctx context.Context) ([]domain.SessionRecord, error) {
	out, err := s.listSessions(ctx,
		`SELECT `+sessionColumns+` FROM ao_sessions ORDER BY project_id, num`)
	if err != nil {
		return nil, fmt.Errorf("list all sessions: %w", err)
	}
	return out, nil
}

func (s *Store) listSessions(ctx context.Context, query string, args ...any) ([]domain.SessionRecord, error) {
	out := make([]domain.SessionRecord, 0)
	err := s.inTenantRead(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, query, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		out = out[:0]
		for rows.Next() {
			rec, err := scanSession(rows)
			if err != nil {
				return err
			}
			out = append(out, rec)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, normalizeError(err)
	}
	return out, nil
}

// CreateSession assigns the per-project identity and inserts the row. The
// next-number read and the insert share one transaction, and the unique index
// on (org_id, project_id, num) is what actually decides a race: two concurrent
// creates in one project cannot both commit the same number.
func (s *Store) CreateSession(ctx context.Context, rec domain.SessionRecord) (domain.SessionRecord, error) {
	activity := normalActivity(rec.Activity, rec.CreatedAt)
	err := s.inTenantWrite(ctx, func(tx pgx.Tx) error {
		var num int64
		if err := tx.QueryRow(
			ctx,
			`SELECT coalesce(max(num), 0) + 1 FROM ao_sessions WHERE project_id = $1`,
			rec.ProjectID,
		).Scan(&num); err != nil {
			return err
		}
		id := domain.SessionID(fmt.Sprintf("%s-%d", rec.ProjectID, num))
		if _, err := tx.Exec(
			ctx,
			`INSERT INTO ao_sessions (
				org_id, id, project_id, owner_user_id, num, issue_id, kind, harness,
				reviewer_harness, auto_review_enabled, display_name, session_mode,
				activity_state, activity_last_at, first_signal_at, is_terminated,
				is_pinned, pinned_at, terminate_on_pr_merge, auto_inject_review,
				auto_inject_ci, cleanup_generation, branch, workspace_path,
				workspace_repo_path, diff_base_sha, diff_base_ref, runtime_handle_id,
				runtime_launch_id, agent_session_id, agent_session_id_launch_id, prompt,
				latest_user_prompt, latest_assistant_update, native_transcript_path,
				preview_url, preview_revision, browser_capability_verifier,
				provider_conversation_id, controller_generation, model,
				created_at, updated_at
			) VALUES (
				ao_current_org_id(), $1, $2, ao_current_user_id(), $3, $4, $5, $6,
				$7, $8, $9, $10,
				$11, $12, $13, $14,
				$15, $16, $17, $18,
				$19, $20, $21, $22,
				$23, $24, $25, $26,
				$27, $28, $29, $30,
				$31, $32, $33,
				$34, $35, $36,
				$37, $38, $39,
				$40, $41
			)`,
			id,
			rec.ProjectID,
			num,
			string(rec.IssueID),
			string(rec.Kind),
			string(rec.Harness),
			string(rec.ReviewerHarness),
			rec.AutoReviewEnabled,
			rec.DisplayName,
			string(domain.NormalizeSessionMode(rec.Mode)),
			string(activity.State),
			activity.LastActivityAt.UTC(),
			nullTime(rec.FirstSignalAt),
			rec.IsTerminated,
			rec.IsPinned,
			nullTimePtr(rec.PinnedAt),
			rec.TerminateOnPRMerge,
			rec.AutoInjectReview,
			rec.AutoInjectCI,
			rec.CleanupGeneration,
			rec.Metadata.Branch,
			rec.Metadata.WorkspacePath,
			rec.Metadata.WorkspaceRepoPath,
			rec.Metadata.DiffBaseSHA,
			rec.Metadata.DiffBaseRef,
			rec.Metadata.RuntimeHandleID,
			rec.Metadata.RuntimeLaunchID,
			rec.Metadata.AgentSessionID,
			rec.Metadata.AgentSessionIDLaunchID,
			rec.Metadata.Prompt,
			rec.Metadata.LatestUserPrompt,
			rec.Metadata.LatestAssistantUpdate,
			rec.Metadata.NativeTranscriptPath,
			rec.Metadata.PreviewURL,
			rec.Metadata.PreviewRevision,
			rec.Metadata.BrowserCapabilityVerifier,
			rec.Metadata.ProviderConversationID,
			rec.Metadata.ControllerGeneration,
			rec.Metadata.Model,
			rec.CreatedAt.UTC(),
			rec.UpdatedAt.UTC(),
		); err != nil {
			return err
		}
		rec.ID = id
		rec.Activity = activity
		return nil
	})
	if err != nil {
		return domain.SessionRecord{}, fmt.Errorf("create session in %s: %w", rec.ProjectID, normalizeError(err))
	}
	return rec, nil
}

// UpdateSession writes the full mutable state of an existing session. Identity
// — id, project, per-project number, created_at — is not in the SET list, so a
// caller holding a stale record cannot move a session between projects.
func (s *Store) UpdateSession(ctx context.Context, rec domain.SessionRecord) error {
	activity := normalActivity(rec.Activity, rec.UpdatedAt)
	if err := s.inTenantWrite(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(
			ctx,
			`UPDATE ao_sessions SET
				issue_id = $2, kind = $3, harness = $4, reviewer_harness = $5,
				auto_review_enabled = $6, display_name = $7, session_mode = $8,
				activity_state = $9, activity_last_at = $10, first_signal_at = $11,
				is_terminated = $12, is_pinned = $13, pinned_at = $14,
				terminate_on_pr_merge = $15, auto_inject_review = $16,
				auto_inject_ci = $17, cleanup_generation = $18, branch = $19,
				workspace_path = $20, workspace_repo_path = $21, diff_base_sha = $22,
				diff_base_ref = $23, runtime_handle_id = $24, runtime_launch_id = $25,
				agent_session_id = $26, agent_session_id_launch_id = $27, prompt = $28,
				latest_user_prompt = $29, latest_assistant_update = $30,
				native_transcript_path = $31, preview_url = $32, preview_revision = $33,
				browser_capability_verifier = $34, provider_conversation_id = $35,
				controller_generation = $36, model = $37, updated_at = $38
			 WHERE id = $1`,
			rec.ID,
			string(rec.IssueID),
			string(rec.Kind),
			string(rec.Harness),
			string(rec.ReviewerHarness),
			rec.AutoReviewEnabled,
			rec.DisplayName,
			string(domain.NormalizeSessionMode(rec.Mode)),
			string(activity.State),
			activity.LastActivityAt.UTC(),
			nullTime(rec.FirstSignalAt),
			rec.IsTerminated,
			rec.IsPinned,
			nullTimePtr(rec.PinnedAt),
			rec.TerminateOnPRMerge,
			rec.AutoInjectReview,
			rec.AutoInjectCI,
			rec.CleanupGeneration,
			rec.Metadata.Branch,
			rec.Metadata.WorkspacePath,
			rec.Metadata.WorkspaceRepoPath,
			rec.Metadata.DiffBaseSHA,
			rec.Metadata.DiffBaseRef,
			rec.Metadata.RuntimeHandleID,
			rec.Metadata.RuntimeLaunchID,
			rec.Metadata.AgentSessionID,
			rec.Metadata.AgentSessionIDLaunchID,
			rec.Metadata.Prompt,
			rec.Metadata.LatestUserPrompt,
			rec.Metadata.LatestAssistantUpdate,
			rec.Metadata.NativeTranscriptPath,
			rec.Metadata.PreviewURL,
			rec.Metadata.PreviewRevision,
			rec.Metadata.BrowserCapabilityVerifier,
			rec.Metadata.ProviderConversationID,
			rec.Metadata.ControllerGeneration,
			rec.Metadata.Model,
			rec.UpdatedAt.UTC(),
		)
		return err
	}); err != nil {
		return fmt.Errorf("update session %s: %w", rec.ID, normalizeError(err))
	}
	return nil
}

// UpdateSessionFromActivitySignal projects activity-derived metadata only while
// the signal still belongs to the session's active launch. The launch and
// controller-generation predicates are in the WHERE clause rather than checked
// beforehand, so a generation that died mid-request cannot win a read-then-write
// race against the generation that replaced it.
func (s *Store) UpdateSessionFromActivitySignal(ctx context.Context, rec domain.SessionRecord) (bool, error) {
	activity := normalActivity(rec.Activity, rec.UpdatedAt)
	var updated int64
	if err := s.inTenantWrite(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(
			ctx,
			`UPDATE ao_sessions SET
				activity_state = $2, activity_last_at = $3, first_signal_at = $4,
				agent_session_id = $5, agent_session_id_launch_id = $6,
				latest_user_prompt = $7, latest_assistant_update = $8,
				native_transcript_path = $9, updated_at = $10
			 WHERE id = $1
			   AND harness = $11
			   AND session_mode = $12
			   AND runtime_launch_id = $13
			   AND controller_generation = $14`,
			rec.ID,
			string(activity.State),
			activity.LastActivityAt.UTC(),
			nullTime(rec.FirstSignalAt),
			rec.Metadata.AgentSessionID,
			rec.Metadata.AgentSessionIDLaunchID,
			rec.Metadata.LatestUserPrompt,
			rec.Metadata.LatestAssistantUpdate,
			rec.Metadata.NativeTranscriptPath,
			rec.UpdatedAt.UTC(),
			string(rec.Harness),
			string(domain.NormalizeSessionMode(rec.Mode)),
			rec.Metadata.RuntimeLaunchID,
			rec.Metadata.ControllerGeneration,
		)
		updated = tag.RowsAffected()
		return err
	}); err != nil {
		return false, fmt.Errorf("update session %s from activity signal: %w", rec.ID, normalizeError(err))
	}
	return updated > 0, nil
}

// RecordSessionLatestUserPrompt persists the latest real user direction and
// nothing else, so it cannot write stale lifecycle state over a change another
// writer has already made.
func (s *Store) RecordSessionLatestUserPrompt(
	ctx context.Context,
	id domain.SessionID,
	prompt string,
	updatedAt time.Time,
) (bool, error) {
	return s.updateSessionFields(ctx, id, "record latest user prompt",
		`latest_user_prompt = $2`, updatedAt, prompt)
}

// ClaimChatControllerGeneration makes generation the only Chat controller
// allowed to project provider events for this session. A missing session is an
// error rather than a miss: an unclaimable generation means the controller must
// not start at all.
func (s *Store) ClaimChatControllerGeneration(
	ctx context.Context,
	id domain.SessionID,
	generation string,
	updatedAt time.Time,
) error {
	claimed, err := s.updateSessionFields(ctx, id, "claim chat controller generation",
		`controller_generation = $2`, updatedAt, generation)
	if err != nil {
		return err
	}
	if !claimed {
		return fmt.Errorf("claim chat controller generation for %s: %w", id, storageports.ErrNotFound)
	}
	return nil
}

// RenameSession sets the user-facing display name.
func (s *Store) RenameSession(
	ctx context.Context,
	id domain.SessionID,
	displayName string,
	updatedAt time.Time,
) (bool, error) {
	return s.updateSessionFields(ctx, id, "rename session", `display_name = $2`, updatedAt, displayName)
}

// SetSessionPinned pins or unpins a session. Unpinning clears the timestamp
// rather than leaving a stale one behind for the sort to trip over.
func (s *Store) SetSessionPinned(
	ctx context.Context,
	id domain.SessionID,
	isPinned bool,
	pinnedAt *time.Time,
	updatedAt time.Time,
) (bool, error) {
	if !isPinned {
		pinnedAt = nil
	}
	return s.updateSessionFields(ctx, id, "set session pinned",
		`is_pinned = $2, pinned_at = $3`, updatedAt, isPinned, nullTimePtr(pinnedAt))
}

// SetSessionPreviewURL persists the preview target and bumps the revision. The
// revision advances even when the URL is unchanged, because a repeated
// `ao preview <same url>` must still reach the browser panel as a navigation.
func (s *Store) SetSessionPreviewURL(
	ctx context.Context,
	id domain.SessionID,
	previewURL string,
	updatedAt time.Time,
) (bool, error) {
	return s.updateSessionFields(ctx, id, "set session preview url",
		`preview_url = $2, preview_revision = preview_revision + 1`, updatedAt, previewURL)
}

// SetSessionTerminateOnPRMerge sets the merge-teardown lifecycle policy.
func (s *Store) SetSessionTerminateOnPRMerge(
	ctx context.Context,
	id domain.SessionID,
	terminate bool,
	updatedAt time.Time,
) (bool, error) {
	return s.updateSessionFields(ctx, id, "set session terminate on pr merge",
		`terminate_on_pr_merge = $2`, updatedAt, terminate)
}

// SetSessionAutoInjectReview toggles automatic review-comment injection.
func (s *Store) SetSessionAutoInjectReview(
	ctx context.Context,
	id domain.SessionID,
	autoInject bool,
	updatedAt time.Time,
) (bool, error) {
	return s.updateSessionFields(ctx, id, "set session auto inject review",
		`auto_inject_review = $2`, updatedAt, autoInject)
}

// SetSessionAutoInjectCI toggles automatic CI-failure injection.
func (s *Store) SetSessionAutoInjectCI(
	ctx context.Context,
	id domain.SessionID,
	autoInject bool,
	updatedAt time.Time,
) (bool, error) {
	return s.updateSessionFields(ctx, id, "set session auto inject ci",
		`auto_inject_ci = $2`, updatedAt, autoInject)
}

// SetSessionReviewerHarness overrides the project's reviewer for this session.
func (s *Store) SetSessionReviewerHarness(
	ctx context.Context,
	id domain.SessionID,
	harness domain.ReviewerHarness,
	updatedAt time.Time,
) (bool, error) {
	return s.updateSessionFields(ctx, id, "set session reviewer harness",
		`reviewer_harness = $2`, updatedAt, string(harness))
}

// SetSessionAutoReview toggles automatic PR review for this session.
func (s *Store) SetSessionAutoReview(
	ctx context.Context,
	id domain.SessionID,
	enabled bool,
	updatedAt time.Time,
) (bool, error) {
	return s.updateSessionFields(ctx, id, "set session auto review",
		`auto_review_enabled = $2`, updatedAt, enabled)
}

// updateSessionFields runs one narrow UPDATE. assignments is a SQL fragment
// built from string literals in this file, never from caller input: $1 is the
// session id, the caller's values start at $2, and updated_at is always last.
func (s *Store) updateSessionFields(
	ctx context.Context,
	id domain.SessionID,
	what string,
	assignments string,
	updatedAt time.Time,
	values ...any,
) (bool, error) {
	args := make([]any, 0, len(values)+2)
	args = append(args, id)
	args = append(args, values...)
	args = append(args, updatedAt.UTC())
	query := fmt.Sprintf(
		`UPDATE ao_sessions SET %s, updated_at = $%d WHERE id = $1`,
		assignments, len(args),
	)
	var updated int64
	if err := s.inTenantWrite(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, query, args...)
		updated = tag.RowsAffected()
		return err
	}); err != nil {
		return false, fmt.Errorf("%s %s: %w", what, id, normalizeError(err))
	}
	return updated > 0, nil
}

// DeleteSession removes a session row only while it is still in seed state. The
// seed predicate lives in the WHERE clause, so a session that acquired a
// workspace between a caller's read and this write is not deleted — that is
// what keeps the no-resurrection guarantee from depending on caller timing.
//
// deleted=false means the row was absent or had progressed past seed state.
// Both are benign: the caller falls back to marking the session terminated.
func (s *Store) DeleteSession(ctx context.Context, id domain.SessionID) (bool, error) {
	var deleted int64
	if err := s.inTenantWrite(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(
			ctx,
			`DELETE FROM ao_sessions
			 WHERE id = $1
			   AND is_terminated = FALSE
			   AND workspace_path = ''
			   AND runtime_handle_id = ''
			   AND agent_session_id = ''
			   AND prompt = ''
			   AND latest_user_prompt = ''
			   AND latest_assistant_update = ''
			   AND native_transcript_path = ''`,
			id,
		)
		deleted = tag.RowsAffected()
		return err
	}); err != nil {
		return false, fmt.Errorf("delete seed session %s: %w", id, normalizeError(err))
	}
	return deleted > 0, nil
}

func scanSession(row scannable) (domain.SessionRecord, error) {
	var (
		rec           domain.SessionRecord
		kind          string
		harness       string
		reviewer      string
		sessionMode   string
		activityState string
		activityAt    time.Time
		firstSignalAt *time.Time
		pinnedAt      *time.Time
	)
	if err := row.Scan(
		&rec.ID, &rec.ProjectID, &rec.IssueID, &kind, &harness, &reviewer,
		&rec.AutoReviewEnabled, &rec.DisplayName, &sessionMode, &activityState, &activityAt,
		&firstSignalAt, &rec.IsTerminated, &rec.IsPinned, &pinnedAt, &rec.TerminateOnPRMerge,
		&rec.AutoInjectReview, &rec.AutoInjectCI, &rec.CleanupGeneration,
		&rec.Metadata.Branch, &rec.Metadata.WorkspacePath, &rec.Metadata.WorkspaceRepoPath,
		&rec.Metadata.DiffBaseSHA, &rec.Metadata.DiffBaseRef, &rec.Metadata.RuntimeHandleID,
		&rec.Metadata.RuntimeLaunchID, &rec.Metadata.AgentSessionID,
		&rec.Metadata.AgentSessionIDLaunchID, &rec.Metadata.Prompt,
		&rec.Metadata.LatestUserPrompt, &rec.Metadata.LatestAssistantUpdate,
		&rec.Metadata.NativeTranscriptPath, &rec.Metadata.PreviewURL,
		&rec.Metadata.PreviewRevision, &rec.Metadata.BrowserCapabilityVerifier,
		&rec.Metadata.ProviderConversationID, &rec.Metadata.ControllerGeneration,
		&rec.Metadata.Model, &rec.CreatedAt, &rec.UpdatedAt,
	); err != nil {
		return domain.SessionRecord{}, err
	}
	rec.Kind = domain.SessionKind(kind)
	rec.Harness = domain.AgentHarness(harness)
	rec.ReviewerHarness = domain.ReviewerHarness(reviewer)
	rec.Mode = domain.NormalizeSessionMode(domain.SessionMode(sessionMode))
	rec.Activity = domain.Activity{
		State:          domain.ActivityState(activityState),
		LastActivityAt: activityAt.UTC(),
	}
	if firstSignalAt != nil {
		rec.FirstSignalAt = firstSignalAt.UTC()
	}
	if pinnedAt != nil {
		utc := pinnedAt.UTC()
		rec.PinnedAt = &utc
	}
	rec.CreatedAt = rec.CreatedAt.UTC()
	rec.UpdatedAt = rec.UpdatedAt.UTC()
	return rec, nil
}

// normalActivity fills in the parts of an activity reading a caller left blank,
// matching what the local store writes so a record round-trips the same on both.
func normalActivity(activity domain.Activity, fallback time.Time) domain.Activity {
	if activity.State == "" {
		activity.State = domain.ActivityIdle
	}
	if activity.LastActivityAt.IsZero() {
		activity.LastActivityAt = fallback
	}
	return activity
}

func nullTimePtr(t *time.Time) *time.Time {
	if t == nil || t.IsZero() {
		return nil
	}
	utc := t.UTC()
	return &utc
}
