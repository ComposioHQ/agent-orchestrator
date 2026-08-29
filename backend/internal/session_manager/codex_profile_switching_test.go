package sessionmanager

import (
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestCodexProfileContinuationSeedRetainsWorkspaceButClearsRuntimeIdentity(t *testing.T) {
	now := time.Date(2026, 8, 29, 10, 0, 0, 0, time.UTC)
	source := domain.SessionRecord{
		ID: "ao-1", ProjectID: "project-1", DisplayName: "Fix the parser", Harness: domain.HarnessCodex,
		IsPinned: true, PinnedAt: &now, IsTerminated: true, ArchivedAt: &now,
		CodexProfileBinding: &domain.CodexSessionBinding{ProfileID: "existing"},
		Metadata: domain.SessionMetadata{
			WorkspacePath: "/repo/worktree", Branch: "feature/parser", RuntimeHandleID: "runtime-1",
			RuntimeLaunchID: "launch-1", AgentSessionID: "native-1", ProviderConversationID: "thread-1",
			ControllerGeneration: "controller-1", NativeTranscriptPath: "/private/transcript.jsonl",
		},
	}
	seed := codexProfileContinuationSeed(source, now.Add(time.Minute))
	if seed.ID != "" || seed.ProjectID != source.ProjectID || seed.Metadata.WorkspacePath != source.Metadata.WorkspacePath || seed.Metadata.Branch != source.Metadata.Branch {
		t.Fatalf("workspace provenance was not retained: %+v", seed)
	}
	if seed.CodexProfileBinding != nil || seed.IsPinned || seed.PinnedAt != nil || seed.IsTerminated || seed.ArchivedAt != nil {
		t.Fatalf("continuation lifecycle was not reset: %+v", seed)
	}
	for name, value := range map[string]string{
		"runtime": seed.Metadata.RuntimeHandleID, "launch": seed.Metadata.RuntimeLaunchID,
		"native": seed.Metadata.AgentSessionID, "provider": seed.Metadata.ProviderConversationID,
		"controller": seed.Metadata.ControllerGeneration, "transcript": seed.Metadata.NativeTranscriptPath,
	} {
		if value != "" {
			t.Errorf("%s identity was retained: %q", name, value)
		}
	}
}

func TestProfileSwitchSemanticRequestUsesGenerationFencedHiddenCommand(t *testing.T) {
	sw := domain.CodexProfileSwitch{ID: "profile-switch-1", SourceGenerationID: "generation-1"}
	request := buildCodexProfileSwitchSourceHandoffRequest(sw, "/private/candidate.json", "/usr/local/bin/ao")
	for _, value := range []string{"profile-switch-1", "generation-1", "--profile-switch", "/private/candidate.json", "/usr/local/bin/ao"} {
		if !strings.Contains(request, value) {
			t.Fatalf("handoff request missing %q: %s", value, request)
		}
	}
}
