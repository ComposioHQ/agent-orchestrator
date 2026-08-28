package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestCodexProfileCatalogAlwaysReturnsExistingWithoutDiskWork(t *testing.T) {
	catalog := newCodexProfileCatalog(filepath.Join(t.TempDir(), "missing"), filepath.Join(t.TempDir(), ".codex"), nil)
	profiles := catalog.snapshots()
	if len(profiles) != 1 || profiles[0].ID != codexExistingProfileID || profiles[0].Source != domain.CodexProfileSourceExisting || !profiles[0].UsableByCurrentLaunches {
		t.Fatalf("cached profiles = %#v", profiles)
	}
}

func TestCodexProfileCatalogCreatesPrivateStrictDescriptor(t *testing.T) {
	root := filepath.Join(t.TempDir(), "profiles")
	catalog := newCodexProfileCatalog(root, filepath.Join(t.TempDir(), ".codex"), nil)
	catalog.newID = func() string { return "72d4db6e-da2c-414c-a6a9-fdbd09a006b6" }
	catalog.now = func() time.Time { return time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC) }
	record, err := catalog.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	if record.Snapshot.Label != "Work" || record.Snapshot.UsableByCurrentLaunches {
		t.Fatalf("created profile = %#v", record.Snapshot)
	}
	profileDir := filepath.Join(root, record.Snapshot.ID)
	for path, want := range map[string]os.FileMode{
		profileDir: 0o700,
		filepath.Join(profileDir, codexProfileHomeDirectory):      0o700,
		filepath.Join(profileDir, codexProfileDescriptorFilename): 0o600,
	} {
		info, statErr := os.Stat(path)
		if statErr != nil {
			t.Fatal(statErr)
		}
		if got := info.Mode().Perm(); got != want {
			t.Errorf("%s mode = %o, want %o", filepath.Base(path), got, want)
		}
	}
	data, err := os.ReadFile(filepath.Join(profileDir, codexProfileDescriptorFilename))
	if err != nil {
		t.Fatal(err)
	}
	var descriptor map[string]any
	if err := json.Unmarshal(data, &descriptor); err != nil {
		t.Fatal(err)
	}
	if len(descriptor) != 5 || descriptor["source"] != "managed" || descriptor["label"] != "Work" {
		t.Fatalf("descriptor = %s", data)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != record.Snapshot.ID {
		t.Fatalf("catalog entries after atomic create = %#v", entries)
	}
	for _, forbidden := range []string{"email", "auth", "plan", "token", "quota", "login"} {
		if _, exists := descriptor[forbidden]; exists {
			t.Errorf("descriptor persisted forbidden field %q", forbidden)
		}
	}
}

func TestCodexProfileCatalogSurfacesBrokenProfilesWithoutStartingAnything(t *testing.T) {
	root := filepath.Join(t.TempDir(), "profiles")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	id := "72d4db6e-da2c-414c-a6a9-fdbd09a006b6"
	if err := os.Mkdir(filepath.Join(root, id), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, id, codexProfileDescriptorFilename), []byte(`{"version":1,"id":"`+id+`","label":"Broken","source":"managed","createdAt":"2026-08-28T12:00:00Z","token":"secret"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	catalog := newCodexProfileCatalog(root, filepath.Join(t.TempDir(), ".codex"), nil)
	if err := catalog.refresh(); err != nil {
		t.Fatal(err)
	}
	profiles := catalog.snapshots()
	if len(profiles) != 2 || profiles[1].Status != domain.CodexProfileStatusBroken || profiles[1].ReasonCode != domain.CodexProfileReasonDescriptorInvalid {
		t.Fatalf("profiles = %#v", profiles)
	}
	if profiles[1].Label == "Broken" {
		t.Fatal("malformed descriptor label leaked into public snapshot")
	}
}

func TestCodexProfileCatalogRejectsSymlinkedManagedHome(t *testing.T) {
	root := filepath.Join(t.TempDir(), "profiles")
	catalog := newCodexProfileCatalog(root, filepath.Join(t.TempDir(), ".codex"), nil)
	catalog.newID = func() string { return "72d4db6e-da2c-414c-a6a9-fdbd09a006b6" }
	record, err := catalog.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(root, record.Snapshot.ID, codexProfileHomeDirectory)
	if err := os.Remove(home); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(t.TempDir(), home); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := catalog.refresh(); err != nil {
		t.Fatal(err)
	}
	broken, _ := catalog.record(record.Snapshot.ID)
	if broken.Snapshot.Status != domain.CodexProfileStatusBroken || broken.Snapshot.ReasonCode != domain.CodexProfileReasonUnsafePath {
		t.Fatalf("profile = %#v", broken.Snapshot)
	}
}

func TestCodexProfileCatalogRediscoveryOrdersProfilesAndRemovesDeletedEntries(t *testing.T) {
	root := filepath.Join(t.TempDir(), "profiles")
	catalog := newCodexProfileCatalog(root, filepath.Join(t.TempDir(), ".codex"), nil)
	ids := []string{"72d4db6e-da2c-414c-a6a9-fdbd09a006b6", "bb1e9a5d-37ad-43f8-83bd-13de8168f8af"}
	times := []time.Time{
		time.Date(2026, 8, 28, 13, 0, 0, 0, time.UTC),
		time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC),
	}
	index := 0
	catalog.newID = func() string { return ids[index] }
	catalog.now = func() time.Time { return times[index] }
	first, err := catalog.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	index++
	second, err := catalog.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	if err := catalog.refresh(); err != nil {
		t.Fatal(err)
	}
	profiles := catalog.snapshots()
	if len(profiles) != 3 || profiles[0].ID != codexExistingProfileID || profiles[1].ID != second.Snapshot.ID || profiles[2].ID != first.Snapshot.ID {
		t.Fatalf("ordered profiles = %#v", profiles)
	}
	if err := os.RemoveAll(filepath.Join(root, second.Snapshot.ID)); err != nil {
		t.Fatal(err)
	}
	if err := catalog.refresh(); err != nil {
		t.Fatal(err)
	}
	if profiles = catalog.snapshots(); len(profiles) != 2 || profiles[1].ID != first.Snapshot.ID {
		t.Fatalf("profiles after external delete = %#v", profiles)
	}
}

func TestCodexProfileCatalogSurfacesMissingHomeAndSymlinkedDescriptorAsBroken(t *testing.T) {
	root := filepath.Join(t.TempDir(), "profiles")
	catalog := newCodexProfileCatalog(root, filepath.Join(t.TempDir(), ".codex"), nil)
	ids := []string{"72d4db6e-da2c-414c-a6a9-fdbd09a006b6", "bb1e9a5d-37ad-43f8-83bd-13de8168f8af"}
	index := 0
	catalog.newID = func() string { return ids[index] }
	missing, err := catalog.create("Missing")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(root, missing.Snapshot.ID, codexProfileHomeDirectory)); err != nil {
		t.Fatal(err)
	}
	index++
	symlinked, err := catalog.create("Symlinked")
	if err != nil {
		t.Fatal(err)
	}
	descriptor := filepath.Join(root, symlinked.Snapshot.ID, codexProfileDescriptorFilename)
	backup := filepath.Join(t.TempDir(), "profile.json")
	data, err := os.ReadFile(descriptor)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(backup, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(descriptor); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(backup, descriptor); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := catalog.refresh(); err != nil {
		t.Fatal(err)
	}
	missingRecord, _ := catalog.record(missing.Snapshot.ID)
	symlinkedRecord, _ := catalog.record(symlinked.Snapshot.ID)
	if missingRecord.Snapshot.ReasonCode != domain.CodexProfileReasonHomeMissing {
		t.Fatalf("missing-home profile = %#v", missingRecord.Snapshot)
	}
	if symlinkedRecord.Snapshot.ReasonCode != domain.CodexProfileReasonDescriptorInvalid {
		t.Fatalf("symlinked-descriptor profile = %#v", symlinkedRecord.Snapshot)
	}
}

func TestCodexProfileCatalogCanonicalHomeDeduplicationDoesNotReadCredentials(t *testing.T) {
	root := filepath.Join(t.TempDir(), "profiles")
	catalog := newCodexProfileCatalog(root, filepath.Join(t.TempDir(), ".codex"), nil)
	catalog.newID = func() string { return "72d4db6e-da2c-414c-a6a9-fdbd09a006b6" }
	record, err := catalog.create("Alias")
	if err != nil {
		t.Fatal(err)
	}
	managedHome := filepath.Join(root, record.Snapshot.ID, codexProfileHomeDirectory)
	if err := os.WriteFile(filepath.Join(managedHome, "auth.json"), []byte("must not be parsed"), 0o000); err != nil {
		t.Fatal(err)
	}
	existingLink := filepath.Join(t.TempDir(), ".codex")
	if err := os.Symlink(managedHome, existingLink); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	deduplicatingCatalog := newCodexProfileCatalog(root, existingLink, nil)
	if err := deduplicatingCatalog.refresh(); err != nil {
		t.Fatal(err)
	}
	profiles := deduplicatingCatalog.snapshots()
	if len(profiles) != 1 || profiles[0].ID != codexExistingProfileID {
		t.Fatalf("canonical-deduplicated profiles = %#v", profiles)
	}
}

func TestValidCodexProfileLabelRejectsWhitespaceControlAndLongValues(t *testing.T) {
	for _, label := range []string{"", " Work", "Work ", "Work\nHome", strings.Repeat("a", 81)} {
		if validCodexProfileLabel(label) {
			t.Errorf("validCodexProfileLabel(%q) = true", label)
		}
	}
	if !validCodexProfileLabel("工作") {
		t.Fatal("Unicode label rejected")
	}
}
