package usage

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestDefaultSourceRootsIncludesPiSessions(t *testing.T) {
	home := t.TempDir()
	piHome := filepath.Join(home, "custom-pi")
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", "")
	t.Setenv("PI_CODING_AGENT_DIR", piHome)

	got, err := DefaultSourceRoots(context.Background())
	mustNoError(t, err)
	if got.PiSessions != filepath.Join(piHome, "sessions") {
		t.Fatalf("Pi sessions = %q, want %q", got.PiSessions, filepath.Join(piHome, "sessions"))
	}
}

// TestCollectorDiscoversPiSessionByHeaderID catches filename-only discovery:
// Pi's native session identity lives in the first JSONL record.
func TestCollectorDiscoversPiSessionByHeaderID(t *testing.T) {
	const nativeID = "pi-session-1"
	store := collectorTestStore(t)
	session := collectorTestSession(t, store, domain.HarnessPi, nativeID, false)
	root := t.TempDir()
	path := filepath.Join(root, "project", "session.jsonl")
	writeUsageFixture(t, path, `{"type":"session","id":"`+nativeID+`","cwd":"/repo","version":3}`+"\n")
	collector := NewCollector(store, SourceRoots{PiSessions: root}, nil)

	mustNoError(t, collector.RecordHook(context.Background(), session.ID, HookSignal{
		Harness: domain.HarnessPi, Event: "session-start", NativeSessionID: nativeID,
	}))
	bindings, err := store.ListUsageBindingsForSession(context.Background(), session.ID)
	if err != nil || len(bindings) != 1 {
		t.Fatalf("bindings=%+v err=%v", bindings, err)
	}
	sources, err := store.ListUsageSourcesForBinding(context.Background(), bindings[0].ID)
	if err != nil || len(sources) != 1 || sources[0].Kind != domain.UsageSourcePiSession ||
		sources[0].ArtifactPath != canonicalUsagePath(t, path) {
		t.Fatalf("sources=%+v err=%v", sources, err)
	}
}

func TestCollectorReconcilePiPathMatchesLiveWorkspace(t *testing.T) {
	const nativeID = "pi-session-from-header"
	store := collectorTestStore(t)
	workspace := t.TempDir()
	session := collectorTestSession(t, store, domain.HarnessPi, "", false)
	session.Metadata.WorkspacePath = workspace
	mustNoError(t, store.UpdateSession(context.Background(), session))
	root := t.TempDir()
	path := filepath.Join(root, "project", "session.jsonl")
	writeUsageFixture(t, path, fmt.Sprintf(
		`{"type":"session","id":%q,"cwd":%q,"version":3}`+"\n", nativeID, workspace,
	))

	collector := NewCollector(store, SourceRoots{PiSessions: root}, nil)
	mustNoError(t, collector.ReconcilePath(context.Background(), path))
	bindings, err := store.ListUsageBindingsForSession(context.Background(), session.ID)
	if err != nil || len(bindings) != 1 || bindings[0].NativeRootID != nativeID {
		t.Fatalf("bindings=%+v err=%v", bindings, err)
	}
}
