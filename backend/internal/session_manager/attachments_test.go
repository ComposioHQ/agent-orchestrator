package sessionmanager

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/attachments"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestWriteSpawnAttachments(t *testing.T) {
	dir := t.TempDir()
	refs, err := writeSpawnAttachments(dir, []ports.SpawnAttachment{
		{Ext: ".html", Data: []byte("first")},
		{Ext: ".png", Data: []byte("second")},
		{Ext: "", Data: []byte("third")},
	})
	if err != nil {
		t.Fatalf("writeSpawnAttachments: %v", err)
	}

	want := []string{".ao/attachments/attachment-1.html", ".ao/attachments/attachment-2.png", ".ao/attachments/attachment-3.bin"}
	if len(refs) != len(want) {
		t.Fatalf("refs = %v, want %v", refs, want)
	}
	for i, ref := range refs {
		if ref != want[i] {
			t.Errorf("ref[%d] = %q, want %q", i, ref, want[i])
		}
		got, readErr := os.ReadFile(filepath.Join(dir, filepath.FromSlash(ref)))
		if readErr != nil {
			t.Fatalf("read %s: %v", ref, readErr)
		}
		if len(got) == 0 {
			t.Errorf("attachment %s is empty on disk", ref)
		}
	}
}

func TestStageAttachmentsUsesNeutralFileNames(t *testing.T) {
	dir := t.TempDir()
	dataDir := t.TempDir()
	st := newFakeStore()
	st.sessions["ao-1"] = domain.SessionRecord{
		ID:       "ao-1",
		Metadata: domain.SessionMetadata{WorkspacePath: dir},
	}
	m := New(Deps{Store: st, Workspace: &fakeWorkspace{}, DataDir: dataDir})

	refs, err := m.StageAttachments(context.Background(), "ao-1", []ports.SpawnAttachment{
		{Ext: ".html", Data: []byte("<main>hi</main>")},
	})
	if err != nil {
		t.Fatalf("StageAttachments: %v", err)
	}
	if len(refs) != 1 {
		t.Fatalf("refs = %v, want one", refs)
	}
	if !strings.HasPrefix(refs[0], ".ao/attachments/attachment-") || !strings.HasSuffix(refs[0], ".html") {
		t.Fatalf("ref = %q, want neutral attachment name with .html extension", refs[0])
	}
	if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(refs[0]))); err != nil {
		t.Fatalf("staged attachment missing on disk: %v", err)
	}
	// The canonical copy is what survives worktree recreation; staging must
	// write it, not just the worktree projection.
	name, ok := attachments.RefName(refs[0])
	if !ok {
		t.Fatalf("ref %q is not a valid attachment reference", refs[0])
	}
	if _, err := os.Stat(filepath.Join(attachments.Dir(dataDir, "ao-1"), name)); err != nil {
		t.Fatalf("canonical attachment copy missing: %v", err)
	}
}

func TestAppendAttachmentReferences(t *testing.T) {
	t.Run("appends after a brief", func(t *testing.T) {
		got := appendAttachmentReferences("Fix the button", []string{".ao/attachments/attachment-1.html"})
		if !strings.HasPrefix(got, "Fix the button\n\n") {
			t.Errorf("brief not preserved: %q", got)
		}
		if !strings.Contains(got, "- .ao/attachments/attachment-1.html") {
			t.Errorf("missing reference: %q", got)
		}
	})

	t.Run("handles empty brief", func(t *testing.T) {
		got := appendAttachmentReferences("", []string{".ao/attachments/attachment-1.html"})
		if strings.HasPrefix(got, "\n") {
			t.Errorf("leading blank line for empty brief: %q", got)
		}
		if !strings.Contains(got, "Attached files") {
			t.Errorf("missing header: %q", got)
		}
		if strings.Contains(got, "Attached images") {
			t.Errorf("header still describes attachments as images: %q", got)
		}
	})

	t.Run("no refs returns prompt unchanged", func(t *testing.T) {
		if got := appendAttachmentReferences("brief", nil); got != "brief" {
			t.Errorf("got %q, want %q", got, "brief")
		}
	})
}

// The full #3884 seam: a staged attachment must survive the exact
// save-and-teardown → restore cycle daemon recovery runs, including a legacy
// attachment that existed only in the worktree (staged by a build without
// durable storage). StashUncommitted skips ignored files by design, so without
// the durable copy these bytes have no other owner.
func TestAttachmentsSurviveTeardownAndRestore(t *testing.T) {
	dataDir := t.TempDir()
	worktree := t.TempDir()

	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	ws := &fakeWorkspace{path: worktree}
	m := New(Deps{
		Runtime:   &fakeRuntime{},
		Agents:    fakeAgents{},
		Workspace: ws,
		Store:     st,
		Messenger: &fakeMessenger{},
		Lifecycle: &fakeLCM{store: st},
		LookPath:  func(string) (string, error) { return "/bin/true", nil },
		DataDir:   dataDir,
	})
	st.sessions["mer-1"] = domain.SessionRecord{
		ID:        "mer-1",
		ProjectID: "mer",
		Kind:      domain.KindWorker,
		Harness:   domain.HarnessClaudeCode,
		Metadata:  domain.SessionMetadata{WorkspacePath: worktree, Branch: "ao/mer-1/root", AgentSessionID: "agent-w"},
		Activity:  domain.Activity{State: domain.ActivityActive},
	}

	staged := []byte("png-bytes-of-a-screenshot")
	refs, err := m.StageAttachments(context.Background(), "mer-1", []ports.SpawnAttachment{
		{Ext: ".png", Data: staged},
	})
	if err != nil {
		t.Fatalf("StageAttachments: %v", err)
	}
	name, ok := attachments.RefName(refs[0])
	if !ok {
		t.Fatalf("staged ref %q is not a valid attachment reference", refs[0])
	}
	canonical := filepath.Join(attachments.Dir(dataDir, "mer-1"), name)
	if got, err := os.ReadFile(canonical); err != nil || string(got) != string(staged) {
		t.Fatalf("canonical copy after staging: err=%v content=%q", err, got)
	}

	// A legacy attachment written by a build that predates durable storage:
	// worktree-only, no canonical copy.
	legacy := []byte("older-screenshot")
	legacyPath := filepath.Join(worktree, ".ao", "attachments", "attachment-legacy1.png")
	if err := os.WriteFile(legacyPath, legacy, 0o600); err != nil {
		t.Fatalf("write legacy attachment: %v", err)
	}

	if err := m.SaveAndTeardownAll(ctx); err != nil {
		t.Fatalf("SaveAndTeardownAll: %v", err)
	}
	// Teardown must have imported the legacy bytes before the worktree died.
	if got, err := os.ReadFile(filepath.Join(attachments.Dir(dataDir, "mer-1"), "attachment-legacy1.png")); err != nil || string(got) != string(legacy) {
		t.Fatalf("legacy attachment not imported at teardown: err=%v content=%q", err, got)
	}

	// The fake workspace records ForceDestroy without touching disk; do the
	// destructive part for real so restore has nothing to lean on.
	if err := os.RemoveAll(filepath.Join(worktree, ".ao")); err != nil {
		t.Fatalf("simulate worktree destruction: %v", err)
	}

	if err := m.RestoreAll(ctx); err != nil {
		t.Fatalf("RestoreAll: %v", err)
	}

	for file, want := range map[string][]byte{
		filepath.Join(worktree, filepath.FromSlash(refs[0])): staged,
		legacyPath: legacy,
	} {
		got, err := os.ReadFile(file)
		if err != nil {
			t.Errorf("attachment missing after restore: %v", err)
			continue
		}
		if string(got) != string(want) {
			t.Errorf("attachment %s = %q after restore, want %q", file, got, want)
		}
	}
}
