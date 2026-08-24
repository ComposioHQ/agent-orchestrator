package usage

import (
	"context"
	"path/filepath"
	"slices"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestDefaultSourceRootsIncludesQwenUsage(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", "")

	got, err := DefaultSourceRoots(context.Background())
	mustNoError(t, err)
	if got.QwenUsage != filepath.Join(home, ".qwen", "usage") {
		t.Fatalf("Qwen usage root = %q", got.QwenUsage)
	}
}

func TestCollectorDiscoversQwenSharedMonthlyUsage(t *testing.T) {
	const nativeID = "qwen-session-1"
	store := collectorTestStore(t)
	session := collectorTestSession(t, store, domain.HarnessQwen, nativeID, false)
	root := t.TempDir()
	path := filepath.Join(root, "token-usage-2026-08.jsonl")
	writeUsageFixture(t, path, `{"schemaVersion":1,"id":"turn-1","sessionId":"`+nativeID+`","model":"qwen3","inputTokens":1,"outputTokens":1,"cachedTokens":0,"thoughtsTokens":0,"totalTokens":2}`+"\n")
	collector := NewCollector(store, SourceRoots{QwenUsage: root}, nil)

	mustNoError(t, collector.RecordHook(context.Background(), session.ID, HookSignal{
		Harness: domain.HarnessQwen, Event: "session-start", NativeSessionID: nativeID,
	}))
	bindings, err := store.ListUsageBindingsForSession(context.Background(), session.ID)
	if err != nil || len(bindings) != 1 {
		t.Fatalf("bindings=%+v err=%v", bindings, err)
	}
	sources, err := store.ListUsageSourcesForBinding(context.Background(), bindings[0].ID)
	if err != nil || len(sources) != 1 || sources[0].Kind != domain.UsageSourceQwenMonthly {
		t.Fatalf("sources=%+v err=%v", sources, err)
	}
}

func TestCollectorQwenRegistersLaterMonthlyRollover(t *testing.T) {
	const nativeID = "qwen-session-1"
	store := collectorTestStore(t)
	session := collectorTestSession(t, store, domain.HarnessQwen, nativeID, false)
	root := t.TempDir()
	july := filepath.Join(root, "token-usage-2026-07.jsonl")
	writeUsageFixture(t, july, "{}\n")
	collector := NewCollector(store, SourceRoots{QwenUsage: root}, nil)

	mustNoError(t, collector.RecordHook(context.Background(), session.ID, HookSignal{
		Harness: domain.HarnessQwen, Event: "session-start", NativeSessionID: nativeID,
	}))
	bindings, _ := store.ListUsageBindingsForSession(context.Background(), session.ID)
	august := filepath.Join(root, "token-usage-2026-08.jsonl")
	writeUsageFixture(t, august, "{}\n")
	mustNoError(t, collector.ReconcileSources(context.Background(), -1))

	sources, err := store.ListUsageSourcesForBinding(context.Background(), bindings[0].ID)
	if err != nil || len(sources) != 2 {
		t.Fatalf("sources=%+v err=%v", sources, err)
	}
	got := []string{sources[0].ArtifactPath, sources[1].ArtifactPath}
	slices.Sort(got)
	want := []string{canonicalUsagePath(t, july), canonicalUsagePath(t, august)}
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Fatalf("paths=%v want=%v", got, want)
	}
}

func TestSourceKindForHarness(t *testing.T) {
	tests := []struct {
		harness domain.AgentHarness
		want    domain.UsageSourceKind
		ok      bool
	}{
		{harness: domain.HarnessClaudeCode, want: domain.UsageSourceClaudeMain, ok: true},
		{harness: domain.HarnessCodex, want: domain.UsageSourceCodexRollout, ok: true},
		{harness: domain.HarnessQwen, want: domain.UsageSourceQwenMonthly, ok: true},
		{harness: domain.HarnessAider, ok: false},
	}
	for _, tt := range tests {
		got, ok := sourceKindForHarness(tt.harness)
		if got != tt.want || ok != tt.ok {
			t.Fatalf("sourceKindForHarness(%q) = %q, %v; want %q, %v", tt.harness, got, ok, tt.want, tt.ok)
		}
	}
}
