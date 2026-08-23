package conformance

import (
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	storageports "github.com/aoagents/agent-orchestrator/backend/internal/storage/ports"
)

var (
	createdAt = time.Date(2026, 3, 14, 15, 9, 26, 535000000, time.UTC)
	updatedAt = time.Date(2026, 3, 14, 16, 30, 0, 0, time.UTC)
)

func runSessions(t *testing.T, newHarness Factory) {
	t.Helper()

	t.Run("create assigns per-project identity and round-trips every fact", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		mustUpsertProject(t, h, newProject("acme", "/repos/acme"))

		want := newSession("acme")
		want.IssueID = "ACME-17"
		want.Kind = domain.KindOrchestrator
		want.ReviewerHarness = domain.ReviewerHarness("codex")
		want.AutoReviewEnabled = true
		want.DisplayName = "orchestrator"
		want.Mode = domain.SessionModeChat
		want.Activity = domain.Activity{State: domain.ActivityWaitingInput, LastActivityAt: updatedAt}
		want.FirstSignalAt = updatedAt
		want.TerminateOnPRMerge = true
		want.AutoInjectReview = true
		want.AutoInjectCI = true
		want.CleanupGeneration = 3
		want.Metadata = domain.SessionMetadata{
			Branch:                    "ao/acme-1",
			WorkspacePath:             "/work/acme-1",
			WorkspaceRepoPath:         "/work/acme-1/repo",
			DiffBaseSHA:               "abc123",
			DiffBaseRef:               "origin/main",
			RuntimeHandleID:           "handle-1",
			RuntimeLaunchID:           "launch-1",
			AgentSessionID:            "agent-1",
			AgentSessionIDLaunchID:    "launch-1",
			Prompt:                    "do the thing",
			LatestUserPrompt:          "do the other thing",
			LatestAssistantUpdate:     "done",
			NativeTranscriptPath:      "/transcripts/acme-1.jsonl",
			ProviderConversationID:    "thread-1",
			ControllerGeneration:      "gen-1",
			PreviewURL:                "http://localhost:3000",
			PreviewRevision:           2,
			Model:                     "opus",
			BrowserCapabilityVerifier: "verifier-1",
		}

		created, err := h.Sessions.CreateSession(ctx, want)
		if err != nil {
			t.Fatalf("CreateSession: %v", err)
		}
		if created.ID != "acme-1" {
			t.Fatalf("created id = %q, want acme-1", created.ID)
		}
		got, ok, err := h.Sessions.GetSession(ctx, created.ID)
		if err != nil || !ok {
			t.Fatalf("GetSession = %v, %v", ok, err)
		}
		want.ID = created.ID
		assertSessionEqual(t, got, want)
	})

	t.Run("per-project numbering is independent and monotonic", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		mustUpsertProject(t, h, newProject("acme", "/repos/acme"))
		mustUpsertProject(t, h, newProject("beta", "/repos/beta"))

		for _, want := range []domain.SessionID{"acme-1", "acme-2", "acme-3"} {
			got, err := h.Sessions.CreateSession(ctx, newSession("acme"))
			if err != nil {
				t.Fatalf("CreateSession: %v", err)
			}
			if got.ID != want {
				t.Fatalf("created id = %q, want %q", got.ID, want)
			}
		}
		got, err := h.Sessions.CreateSession(ctx, newSession("beta"))
		if err != nil || got.ID != "beta-1" {
			t.Fatalf("first beta session = %q, %v", got.ID, err)
		}
	})

	t.Run("numbering continues above the highest surviving session", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		mustUpsertProject(t, h, newProject("acme", "/repos/acme"))
		mustCreateSession(t, h, newSession("acme"))
		second := mustCreateSession(t, h, newSession("acme"))

		// A rolled-back spawn deletes its seed row. The next create takes the
		// number back, which is safe precisely because a seed row never became
		// observable: nothing outside the store ever named acme-2.
		deleted, err := h.Sessions.DeleteSession(ctx, second.ID)
		if err != nil || !deleted {
			t.Fatalf("DeleteSession(seed) = %v, %v", deleted, err)
		}
		next, err := h.Sessions.CreateSession(ctx, newSession("acme"))
		if err != nil {
			t.Fatalf("CreateSession: %v", err)
		}
		if next.ID != second.ID {
			t.Fatalf("next session id = %q, want the freed %q", next.ID, second.ID)
		}
		if _, ok, err := h.Sessions.GetSession(ctx, next.ID); !ok || err != nil {
			t.Fatalf("GetSession(%s) = %v, %v", next.ID, ok, err)
		}
	})

	t.Run("GetSession reports absence without an error", func(t *testing.T) {
		h := newHarness(t)
		if got, ok, err := h.Sessions.GetSession(h.ctx(), "ghost-1"); ok || err != nil {
			t.Fatalf("GetSession(missing) = %#v, %v, %v", got, ok, err)
		}
	})

	t.Run("lists are scoped, ordered, and single-query complete", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		mustUpsertProject(t, h, newProject("acme", "/repos/acme"))
		mustUpsertProject(t, h, newProject("beta", "/repos/beta"))
		for i := 0; i < 3; i++ {
			mustCreateSession(t, h, newSession("acme"))
		}
		mustCreateSession(t, h, newSession("beta"))

		acme, err := h.Sessions.ListSessions(ctx, "acme")
		if err != nil {
			t.Fatalf("ListSessions: %v", err)
		}
		if ids := sessionIDs(acme); len(ids) != 3 || ids[0] != "acme-1" || ids[2] != "acme-3" {
			t.Fatalf("ListSessions(acme) = %v", ids)
		}
		all, err := h.Sessions.ListAllSessions(ctx)
		if err != nil {
			t.Fatalf("ListAllSessions: %v", err)
		}
		if len(all) != 4 {
			t.Fatalf("ListAllSessions returned %d rows, want 4: %v", len(all), sessionIDs(all))
		}
		if got, err := h.Sessions.ListSessions(ctx, "ghost"); err != nil || len(got) != 0 {
			t.Fatalf("ListSessions(missing project) = %#v, %v", got, err)
		}
	})

	t.Run("ListSessions carries the same fields as GetSession", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		mustUpsertProject(t, h, newProject("acme", "/repos/acme"))
		seed := newSession("acme")
		seed.DisplayName = "listed"
		seed.Metadata.WorkspacePath = "/work/acme-1"
		seed.Metadata.Model = "opus"
		created := mustCreateSession(t, h, seed)

		listed, err := h.Sessions.ListSessions(ctx, "acme")
		if err != nil || len(listed) != 1 {
			t.Fatalf("ListSessions = %#v, %v", listed, err)
		}
		fetched, ok, err := h.Sessions.GetSession(ctx, created.ID)
		if err != nil || !ok {
			t.Fatalf("GetSession = %v, %v", ok, err)
		}
		assertSessionEqual(t, listed[0], fetched)
	})

	t.Run("UpdateSession rewrites mutable state and leaves identity alone", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		mustUpsertProject(t, h, newProject("acme", "/repos/acme"))
		rec := mustCreateSession(t, h, newSession("acme"))

		rec.DisplayName = "renamed by update"
		rec.IsTerminated = true
		rec.Activity = domain.Activity{State: domain.ActivityExited, LastActivityAt: updatedAt}
		rec.Metadata.WorkspacePath = "/work/acme-1"
		rec.Metadata.RuntimeHandleID = "handle-9"
		rec.CleanupGeneration = 7
		rec.UpdatedAt = updatedAt
		if err := h.Sessions.UpdateSession(ctx, rec); err != nil {
			t.Fatalf("UpdateSession: %v", err)
		}
		got, ok, err := h.Sessions.GetSession(ctx, rec.ID)
		if err != nil || !ok {
			t.Fatalf("GetSession = %v, %v", ok, err)
		}
		if got.ProjectID != "acme" || !got.CreatedAt.Equal(createdAt) {
			t.Fatalf("identity moved: %#v", got)
		}
		assertSessionEqual(t, got, rec)
	})

	t.Run("activity-signal updates are fenced on the active launch", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		mustUpsertProject(t, h, newProject("acme", "/repos/acme"))
		seed := newSession("acme")
		seed.Metadata.RuntimeLaunchID = "launch-1"
		rec := mustCreateSession(t, h, seed)

		fresh := rec
		fresh.Activity = domain.Activity{State: domain.ActivityActive, LastActivityAt: updatedAt}
		fresh.FirstSignalAt = updatedAt
		fresh.Metadata.AgentSessionID = "agent-1"
		fresh.Metadata.LatestUserPrompt = "go"
		fresh.UpdatedAt = updatedAt
		applied, err := h.Sessions.UpdateSessionFromActivitySignal(ctx, fresh)
		if err != nil || !applied {
			t.Fatalf("fresh signal applied = %v, %v", applied, err)
		}

		stale := fresh
		stale.Metadata.RuntimeLaunchID = "launch-0"
		stale.Activity = domain.Activity{State: domain.ActivityIdle, LastActivityAt: updatedAt}
		stale.Metadata.LatestUserPrompt = "stale"
		applied, err = h.Sessions.UpdateSessionFromActivitySignal(ctx, stale)
		if err != nil {
			t.Fatalf("stale signal: %v", err)
		}
		if applied {
			t.Fatal("a signal from a superseded launch was applied")
		}
		got, _, err := h.Sessions.GetSession(ctx, rec.ID)
		if err != nil {
			t.Fatalf("GetSession: %v", err)
		}
		if got.Activity.State != domain.ActivityActive || got.Metadata.LatestUserPrompt != "go" {
			t.Fatalf("stale signal leaked into the row: %#v", got)
		}
	})

	t.Run("RecordSessionLatestUserPrompt touches only the prompt", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		mustUpsertProject(t, h, newProject("acme", "/repos/acme"))
		rec := mustCreateSession(t, h, newSession("acme"))

		ok, err := h.Sessions.RecordSessionLatestUserPrompt(ctx, rec.ID, "latest direction", updatedAt)
		if err != nil || !ok {
			t.Fatalf("RecordSessionLatestUserPrompt = %v, %v", ok, err)
		}
		got, _, err := h.Sessions.GetSession(ctx, rec.ID)
		if err != nil {
			t.Fatalf("GetSession: %v", err)
		}
		if got.Metadata.LatestUserPrompt != "latest direction" {
			t.Fatalf("prompt = %q", got.Metadata.LatestUserPrompt)
		}
		if got.Activity.State != rec.Activity.State || got.IsTerminated != rec.IsTerminated {
			t.Fatalf("lifecycle state moved: %#v", got)
		}
		if ok, err := h.Sessions.RecordSessionLatestUserPrompt(ctx, "ghost-1", "x", updatedAt); err != nil || ok {
			t.Fatalf("missing session = %v, %v, want false, nil", ok, err)
		}
	})

	t.Run("claiming a chat controller generation fences the session", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		mustUpsertProject(t, h, newProject("acme", "/repos/acme"))
		seed := newSession("acme")
		seed.Mode = domain.SessionModeChat
		rec := mustCreateSession(t, h, seed)

		if err := h.Sessions.ClaimChatControllerGeneration(ctx, rec.ID, "gen-1", updatedAt); err != nil {
			t.Fatalf("ClaimChatControllerGeneration: %v", err)
		}
		got, _, err := h.Sessions.GetSession(ctx, rec.ID)
		if err != nil {
			t.Fatalf("GetSession: %v", err)
		}
		if got.Metadata.ControllerGeneration != "gen-1" {
			t.Fatalf("generation = %q", got.Metadata.ControllerGeneration)
		}
		if err := h.Sessions.ClaimChatControllerGeneration(ctx, "ghost-1", "gen-1", updatedAt); err == nil {
			t.Fatal("claiming a generation on a missing session must fail")
		}
	})

	t.Run("per-field setters apply and report a miss for unknown sessions", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		mustUpsertProject(t, h, newProject("acme", "/repos/acme"))
		rec := mustCreateSession(t, h, newSession("acme"))
		pinnedAt := updatedAt

		setters := []struct {
			name  string
			apply func(id domain.SessionID) (bool, error)
			check func(domain.SessionRecord) bool
		}{
			{
				"RenameSession",
				func(id domain.SessionID) (bool, error) {
					return h.Sessions.RenameSession(ctx, id, "renamed", updatedAt)
				},
				func(r domain.SessionRecord) bool { return r.DisplayName == "renamed" },
			},
			{
				"SetSessionPinned",
				func(id domain.SessionID) (bool, error) {
					return h.Sessions.SetSessionPinned(ctx, id, true, &pinnedAt, updatedAt)
				},
				func(r domain.SessionRecord) bool {
					return r.IsPinned && r.PinnedAt != nil && r.PinnedAt.Equal(pinnedAt)
				},
			},
			{
				"SetSessionPreviewURL",
				func(id domain.SessionID) (bool, error) {
					return h.Sessions.SetSessionPreviewURL(ctx, id, "http://localhost:5173", updatedAt)
				},
				func(r domain.SessionRecord) bool {
					return r.Metadata.PreviewURL == "http://localhost:5173" && r.Metadata.PreviewRevision > 0
				},
			},
			{
				"SetSessionTerminateOnPRMerge",
				func(id domain.SessionID) (bool, error) {
					return h.Sessions.SetSessionTerminateOnPRMerge(ctx, id, true, updatedAt)
				},
				func(r domain.SessionRecord) bool { return r.TerminateOnPRMerge },
			},
			{
				"SetSessionAutoInjectReview",
				func(id domain.SessionID) (bool, error) {
					return h.Sessions.SetSessionAutoInjectReview(ctx, id, true, updatedAt)
				},
				func(r domain.SessionRecord) bool { return r.AutoInjectReview },
			},
			{
				"SetSessionAutoInjectCI",
				func(id domain.SessionID) (bool, error) {
					return h.Sessions.SetSessionAutoInjectCI(ctx, id, true, updatedAt)
				},
				func(r domain.SessionRecord) bool { return r.AutoInjectCI },
			},
			{
				"SetSessionReviewerHarness",
				func(id domain.SessionID) (bool, error) {
					return h.Sessions.SetSessionReviewerHarness(ctx, id, domain.ReviewerHarness("codex"), updatedAt)
				},
				func(r domain.SessionRecord) bool { return r.ReviewerHarness == domain.ReviewerHarness("codex") },
			},
			{
				"SetSessionAutoReview",
				func(id domain.SessionID) (bool, error) {
					return h.Sessions.SetSessionAutoReview(ctx, id, true, updatedAt)
				},
				func(r domain.SessionRecord) bool { return r.AutoReviewEnabled },
			},
		}
		for _, setter := range setters {
			ok, err := setter.apply(rec.ID)
			if err != nil || !ok {
				t.Fatalf("%s = %v, %v", setter.name, ok, err)
			}
			got, found, err := h.Sessions.GetSession(ctx, rec.ID)
			if err != nil || !found {
				t.Fatalf("%s: GetSession = %v, %v", setter.name, found, err)
			}
			if !setter.check(got) {
				t.Fatalf("%s did not take effect: %#v", setter.name, got)
			}
			if ok, err := setter.apply("ghost-1"); err != nil || ok {
				t.Fatalf("%s(missing) = %v, %v, want false, nil", setter.name, ok, err)
			}
		}
	})

	t.Run("unpinning clears the pin timestamp", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		mustUpsertProject(t, h, newProject("acme", "/repos/acme"))
		rec := mustCreateSession(t, h, newSession("acme"))
		pinnedAt := updatedAt
		if _, err := h.Sessions.SetSessionPinned(ctx, rec.ID, true, &pinnedAt, updatedAt); err != nil {
			t.Fatalf("pin: %v", err)
		}
		if _, err := h.Sessions.SetSessionPinned(ctx, rec.ID, false, nil, updatedAt); err != nil {
			t.Fatalf("unpin: %v", err)
		}
		got, _, err := h.Sessions.GetSession(ctx, rec.ID)
		if err != nil {
			t.Fatalf("GetSession: %v", err)
		}
		if got.IsPinned || got.PinnedAt != nil {
			t.Fatalf("unpin left %#v", got)
		}
	})

	t.Run("a repeated preview URL still bumps the revision", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		mustUpsertProject(t, h, newProject("acme", "/repos/acme"))
		rec := mustCreateSession(t, h, newSession("acme"))
		const url = "http://localhost:5173"
		if _, err := h.Sessions.SetSessionPreviewURL(ctx, rec.ID, url, updatedAt); err != nil {
			t.Fatalf("first preview: %v", err)
		}
		first, _, err := h.Sessions.GetSession(ctx, rec.ID)
		if err != nil {
			t.Fatalf("GetSession: %v", err)
		}
		if _, err := h.Sessions.SetSessionPreviewURL(ctx, rec.ID, url, updatedAt); err != nil {
			t.Fatalf("second preview: %v", err)
		}
		second, _, err := h.Sessions.GetSession(ctx, rec.ID)
		if err != nil {
			t.Fatalf("GetSession: %v", err)
		}
		if second.Metadata.PreviewRevision <= first.Metadata.PreviewRevision {
			t.Fatalf("revision did not advance: %d then %d",
				first.Metadata.PreviewRevision, second.Metadata.PreviewRevision)
		}
	})

	t.Run("DeleteSession removes seed rows and refuses everything else", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		mustUpsertProject(t, h, newProject("acme", "/repos/acme"))

		seed := mustCreateSession(t, h, newSession("acme"))
		deleted, err := h.Sessions.DeleteSession(ctx, seed.ID)
		if err != nil || !deleted {
			t.Fatalf("DeleteSession(seed) = %v, %v", deleted, err)
		}
		if _, ok, err := h.Sessions.GetSession(ctx, seed.ID); ok || err != nil {
			t.Fatalf("seed row survived: %v, %v", ok, err)
		}

		spawned := mustCreateSession(t, h, newSession("acme"))
		spawned.Metadata.WorkspacePath = "/work/acme-2"
		spawned.UpdatedAt = updatedAt
		if err := h.Sessions.UpdateSession(ctx, spawned); err != nil {
			t.Fatalf("UpdateSession: %v", err)
		}
		deleted, err = h.Sessions.DeleteSession(ctx, spawned.ID)
		if err != nil {
			t.Fatalf("DeleteSession(spawned): %v", err)
		}
		if deleted {
			t.Fatal("a session with observable spawn output was deleted")
		}
		if _, ok, err := h.Sessions.GetSession(ctx, spawned.ID); !ok || err != nil {
			t.Fatalf("spawned row disappeared: %v, %v", ok, err)
		}

		if deleted, err := h.Sessions.DeleteSession(ctx, "ghost-1"); err != nil || deleted {
			t.Fatalf("DeleteSession(missing) = %v, %v, want false, nil", deleted, err)
		}
	})

	t.Run("a terminated session is never seed-deletable", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		mustUpsertProject(t, h, newProject("acme", "/repos/acme"))
		rec := mustCreateSession(t, h, newSession("acme"))
		rec.IsTerminated = true
		rec.UpdatedAt = updatedAt
		if err := h.Sessions.UpdateSession(ctx, rec); err != nil {
			t.Fatalf("UpdateSession: %v", err)
		}
		if deleted, err := h.Sessions.DeleteSession(ctx, rec.ID); err != nil || deleted {
			t.Fatalf("DeleteSession(terminated) = %v, %v, want false, nil", deleted, err)
		}
	})
}

func newSession(project domain.ProjectID) domain.SessionRecord {
	return domain.SessionRecord{
		ProjectID: project,
		Kind:      domain.KindWorker,
		Harness:   domain.HarnessClaudeCode,
		Mode:      domain.SessionModeTUI,
		Activity:  domain.Activity{State: domain.ActivityIdle, LastActivityAt: createdAt},
		CreatedAt: createdAt,
		UpdatedAt: createdAt,
	}
}

func mustCreateSession(t *testing.T, h Harness, rec domain.SessionRecord) domain.SessionRecord {
	t.Helper()
	created, err := h.Sessions.CreateSession(h.ctx(), rec)
	if err != nil {
		t.Fatalf("CreateSession(%s): %v", rec.ProjectID, err)
	}
	return created
}

func sessionIDs(rows []domain.SessionRecord) []domain.SessionID {
	out := make([]domain.SessionID, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.ID)
	}
	return out
}

func assertSessionEqual(t *testing.T, got, want domain.SessionRecord) {
	t.Helper()
	if got.ID != want.ID || got.ProjectID != want.ProjectID || got.IssueID != want.IssueID ||
		got.Kind != want.Kind || got.Harness != want.Harness ||
		got.ReviewerHarness != want.ReviewerHarness || got.AutoReviewEnabled != want.AutoReviewEnabled ||
		got.DisplayName != want.DisplayName ||
		domain.NormalizeSessionMode(got.Mode) != domain.NormalizeSessionMode(want.Mode) {
		t.Fatalf("session identity = %#v, want %#v", got, want)
	}
	if got.IsTerminated != want.IsTerminated || got.IsPinned != want.IsPinned ||
		got.TerminateOnPRMerge != want.TerminateOnPRMerge ||
		got.AutoInjectReview != want.AutoInjectReview || got.AutoInjectCI != want.AutoInjectCI ||
		got.CleanupGeneration != want.CleanupGeneration {
		t.Fatalf("session flags = %#v, want %#v", got, want)
	}
	if got.Activity.State != want.Activity.State || !got.Activity.LastActivityAt.Equal(want.Activity.LastActivityAt) {
		t.Fatalf("activity = %#v, want %#v", got.Activity, want.Activity)
	}
	if !got.FirstSignalAt.Equal(want.FirstSignalAt) {
		t.Fatalf("FirstSignalAt = %v, want %v", got.FirstSignalAt, want.FirstSignalAt)
	}
	if !got.CreatedAt.Equal(want.CreatedAt) || !got.UpdatedAt.Equal(want.UpdatedAt) {
		t.Fatalf("timestamps = %v/%v, want %v/%v", got.CreatedAt, got.UpdatedAt, want.CreatedAt, want.UpdatedAt)
	}
	switch {
	case got.PinnedAt == nil && want.PinnedAt != nil,
		got.PinnedAt != nil && want.PinnedAt == nil:
		t.Fatalf("PinnedAt = %v, want %v", got.PinnedAt, want.PinnedAt)
	case got.PinnedAt != nil && want.PinnedAt != nil && !got.PinnedAt.Equal(*want.PinnedAt):
		t.Fatalf("PinnedAt = %v, want %v", *got.PinnedAt, *want.PinnedAt)
	}
	if got.Metadata != want.Metadata {
		t.Fatalf("metadata = %#v, want %#v", got.Metadata, want.Metadata)
	}
}

// errIsPortError keeps the suite honest about the shared error vocabulary
// without forcing an implementation to return a specific wrapped message.
func errIsPortError(err error) bool {
	return errors.Is(err, storageports.ErrNotFound) ||
		errors.Is(err, storageports.ErrConflict) ||
		errors.Is(err, storageports.ErrInvalid) ||
		errors.Is(err, storageports.ErrTenantRequired)
}
