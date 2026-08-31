package sessionimportsvc

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	projectsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/project"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/sessionimport"
)

// fakeSource is a discovery source returning canned conversations, so import
// orchestration can be exercised without touching disk.
type fakeSource struct {
	provider domain.AgentHarness
	sessions []sessionimport.ImportableSession
}

func (f *fakeSource) Provider() domain.AgentHarness { return f.provider }
func (f *fakeSource) Discover(context.Context, sessionimport.DiscoverOptions) ([]sessionimport.ImportableSession, error) {
	return f.sessions, nil
}

func TestBestProjectForDir(t *testing.T) {
	projects := []projectsvc.Summary{
		{ID: "root", Path: "/Users/dev/code"},
		{ID: "nested", Path: "/Users/dev/code/app"},
		{ID: "other", Path: "/Users/dev/other"},
	}
	cases := map[string]domain.ProjectID{
		"/Users/dev/code/app/src": "nested", // nearest ancestor wins over root
		"/Users/dev/code/app":     "nested", // exact match
		"/Users/dev/code/lib":     "root",   // only root covers it
		"/Users/dev/elsewhere":    "",       // no cover
	}
	for dir, want := range cases {
		got, ok := bestProjectForDir(projects, dir)
		if want == "" {
			if ok {
				t.Errorf("%s: expected no match, got %s", dir, got)
			}
			continue
		}
		if !ok || got != want {
			t.Errorf("%s: got %q (ok=%v), want %q", dir, got, ok, want)
		}
	}
}

func TestDirIsAncestor(t *testing.T) {
	if !dirIsAncestor("/a/b", "/a/b/c") {
		t.Error("/a/b should be ancestor of /a/b/c")
	}
	if dirIsAncestor("/a/b", "/a/b") {
		t.Error("a dir is not a strict ancestor of itself")
	}
	if dirIsAncestor("/a/b/c", "/a/b") {
		t.Error("child is not an ancestor of parent")
	}
	if dirIsAncestor("/a/bc", "/a/b") {
		t.Error("sibling prefix should not count as ancestor")
	}
}

func TestGitRootWalksUp(t *testing.T) {
	root := t.TempDir()
	deep := filepath.Join(root, "pkg", "sub")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	// .git at the repo root.
	if err := os.MkdirAll(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := gitRoot(deep); got != filepath.Clean(root) {
		t.Errorf("gitRoot(%s) = %s, want %s", deep, got, root)
	}
	// No .git anywhere -> returns the input unchanged.
	noRepo := t.TempDir()
	if got := gitRoot(noRepo); got != filepath.Clean(noRepo) {
		t.Errorf("gitRoot(no repo) = %s, want %s", got, noRepo)
	}
}

func TestImportDisplayName(t *testing.T) {
	if got := importDisplayName("short"); got != "short" {
		t.Errorf("short title changed: %q", got)
	}
	long := importDisplayName("This is a very long conversation title that exceeds the cap")
	if r := []rune(long); len(r) > maxImportDisplayName {
		t.Errorf("display name not truncated to cap: %q (%d runes)", long, len(r))
	}
}

// --- Import orchestration with fakes ---

type fakeSessions struct {
	spawned  ports.SpawnConfig
	spawnErr error
	get      map[domain.SessionID]domain.Session
}

func (f *fakeSessions) Spawn(_ context.Context, cfg ports.SpawnConfig) (domain.Session, int, int, error) {
	f.spawned = cfg
	if f.spawnErr != nil {
		return domain.Session{}, 0, 0, f.spawnErr
	}
	return domain.Session{SessionRecord: domain.SessionRecord{ID: "proj-1", Harness: cfg.Harness}}, 0, 0, nil
}

func (f *fakeSessions) Get(_ context.Context, id domain.SessionID) (domain.Session, error) {
	return f.get[id], nil
}

type fakeStore struct{ recs []domain.SessionRecord }

func (f *fakeStore) ListAllSessions(context.Context) ([]domain.SessionRecord, error) {
	return f.recs, nil
}

type fakeProjects struct {
	list  []projectsvc.Summary
	added projectsvc.AddInput
}

func (f *fakeProjects) List(context.Context) ([]projectsvc.Summary, error) { return f.list, nil }
func (f *fakeProjects) Add(_ context.Context, in projectsvc.AddInput) (projectsvc.Project, error) {
	f.added = in
	return projectsvc.Project{ID: "created-1", Path: in.Path}, nil
}

func TestImportIsIdempotent(t *testing.T) {
	existing := domain.Session{SessionRecord: domain.SessionRecord{ID: "proj-9"}}
	sessions := &fakeSessions{get: map[domain.SessionID]domain.Session{"proj-9": existing}}
	store := &fakeStore{recs: []domain.SessionRecord{
		{ID: "proj-9", Metadata: domain.SessionMetadata{ProviderConversationID: "native-abc"}},
	}}
	svc := New(sessions, store, &fakeProjects{})

	got, already, err := svc.Import(context.Background(), domain.HarnessClaudeCode, "native-abc")
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if !already {
		t.Error("expected alreadyImported=true for a native id already bound")
	}
	if got.ID != "proj-9" {
		t.Errorf("expected the existing session, got %s", got.ID)
	}
	if sessions.spawned.Harness != "" {
		t.Error("idempotent import must not spawn a new session")
	}
}

func TestImportSpawnsChatSessionBoundToNativeID(t *testing.T) {
	target := sessionimport.ImportableSession{
		Provider:        domain.HarnessClaudeCode,
		NativeSessionID: "nat-1",
		ConfigDir:       "/home/user/.claude",
		CWD:             "/Users/dev/code",
		Title:           "A conversation worth continuing",
	}
	src := &fakeSource{provider: domain.HarnessClaudeCode, sessions: []sessionimport.ImportableSession{target}}
	sessions := &fakeSessions{}
	store := &fakeStore{}
	projects := &fakeProjects{list: []projectsvc.Summary{{ID: "proj-existing", Path: "/Users/dev/code"}}}
	svc := New(sessions, store, projects, src)

	got, already, err := svc.Import(context.Background(), domain.HarnessClaudeCode, "nat-1")
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if already {
		t.Error("fresh import should not be flagged already imported")
	}
	if got.ID == "" {
		t.Error("expected a spawned session")
	}

	cfg := sessions.spawned
	if cfg.ProjectID != "proj-existing" {
		t.Errorf("expected the covering project, got %q", cfg.ProjectID)
	}
	if cfg.Harness != domain.HarnessClaudeCode {
		t.Errorf("harness: got %q", cfg.Harness)
	}
	if cfg.RequestedMode != domain.SessionModeChat {
		t.Errorf("import must be chat mode, got %q", cfg.RequestedMode)
	}
	if cfg.ResumeNativeSession == nil {
		t.Fatal("ResumeNativeSession must be set so the transcript is replayed")
	}
	if cfg.ResumeNativeSession.NativeSessionID != "nat-1" ||
		cfg.ResumeNativeSession.ConfigDir != "/home/user/.claude" ||
		cfg.ResumeNativeSession.Provider != domain.HarnessClaudeCode {
		t.Errorf("ResumeNativeSession not populated correctly: %+v", cfg.ResumeNativeSession)
	}
	if projects.added.Path != "" {
		t.Errorf("a covering project existed; no new project should be registered (added %q)", projects.added.Path)
	}
}

func TestImportRegistersProjectWhenNoneCovers(t *testing.T) {
	// A real git repo so gitRoot resolves and Add is exercised with a valid path.
	repo := t.TempDir()
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	target := sessionimport.ImportableSession{
		Provider:        domain.HarnessCodex,
		NativeSessionID: "codex-root-1",
		ConfigDir:       "/home/user/.codex",
		CWD:             repo,
		Title:           "codex thread",
	}
	src := &fakeSource{provider: domain.HarnessCodex, sessions: []sessionimport.ImportableSession{target}}
	sessions := &fakeSessions{}
	projects := &fakeProjects{} // no projects -> must register one

	svc := New(sessions, &fakeStore{}, projects, src)
	if _, _, err := svc.Import(context.Background(), domain.HarnessCodex, "codex-root-1"); err != nil {
		t.Fatalf("import: %v", err)
	}
	if projects.added.Path != filepath.Clean(repo) {
		t.Errorf("expected a project registered at the repo root %q, got %q", repo, projects.added.Path)
	}
	if sessions.spawned.ProjectID != "created-1" {
		t.Errorf("expected the newly created project, got %q", sessions.spawned.ProjectID)
	}
}

func TestNativeIDSetCollectsBothFields(t *testing.T) {
	set := nativeIDSet([]domain.SessionRecord{
		{Metadata: domain.SessionMetadata{ProviderConversationID: "pc1"}},
		{Metadata: domain.SessionMetadata{AgentSessionID: "as1"}},
		{Metadata: domain.SessionMetadata{}},
	})
	if _, ok := set["pc1"]; !ok {
		t.Error("missing provider conversation id")
	}
	if _, ok := set["as1"]; !ok {
		t.Error("missing agent session id")
	}
	if len(set) != 2 {
		t.Errorf("unexpected set size: %d", len(set))
	}
}
