package session

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type fakeRemoteObservation struct {
	list        ports.WorkspaceFiles
	file        ports.WorkspaceFile
	blob        ports.WorkspaceBlob
	preview     ports.PreviewFile
	events      chan ports.WorkspaceEvent
	err         error
	calls       []string
	invalidated domain.SessionID
}

func (f *fakeRemoteObservation) ListWorkspaceFiles(context.Context, domain.SessionID) (ports.WorkspaceFiles, error) {
	f.calls = append(f.calls, "list")
	return f.list, f.err
}
func (f *fakeRemoteObservation) ReadWorkspaceFile(context.Context, domain.SessionID, string) (ports.WorkspaceFile, error) {
	f.calls = append(f.calls, "read")
	return f.file, f.err
}
func (f *fakeRemoteObservation) ReadWorkspaceBlob(context.Context, domain.SessionID, string, ports.WorkspaceBlobSide) (ports.WorkspaceBlob, error) {
	f.calls = append(f.calls, "blob")
	return f.blob, f.err
}
func (f *fakeRemoteObservation) WatchWorkspace(context.Context, domain.SessionID) (<-chan ports.WorkspaceEvent, error) {
	f.calls = append(f.calls, "watch")
	return f.events, f.err
}
func (f *fakeRemoteObservation) ReadPreviewFile(context.Context, domain.SessionID, string) (ports.PreviewFile, error) {
	f.calls = append(f.calls, "preview")
	return f.preview, f.err
}
func (f *fakeRemoteObservation) DiscoverPreview(context.Context, domain.SessionID) (string, bool, error) {
	f.calls = append(f.calls, "discover")
	return "dist/index.html", true, f.err
}
func (f *fakeRemoteObservation) InvalidateWorkspace(id domain.SessionID) {
	f.calls = append(f.calls, "invalidate")
	f.invalidated = id
}

func TestWorkspaceContentDelegatesEveryRemoteOperationWithoutLocalState(t *testing.T) {
	events := make(chan ports.WorkspaceEvent, 1)
	events <- ports.WorkspaceEvent{}
	remote := &fakeRemoteObservation{
		list:    ports.WorkspaceFiles{SessionID: "remote", Files: []ports.WorkspaceFileSummary{{Path: "remote.txt"}}},
		file:    ports.WorkspaceFile{SessionID: "remote", Path: "remote.txt", Content: "remote", Diff: "diff"},
		blob:    ports.WorkspaceBlob{Path: "image.png", Side: ports.WorkspaceBlobAfter, Data: []byte{1, 2, 3}},
		preview: ports.PreviewFile{Path: "index.html", Name: "index.html", Data: []byte("remote preview"), ModTime: time.Unix(1, 0)},
		events:  events,
	}
	// Nil manager/store/cache are intentional: touching any legacy local path
	// would panic, so successful calls prove the injected boundary is complete.
	svc := &Service{workspaceObservation: remote}
	ctx := context.Background()
	list, err := svc.ListWorkspaceFiles(ctx, "remote")
	if err != nil || !reflect.DeepEqual(list, remote.list) {
		t.Fatalf("list = %#v, %v", list, err)
	}
	file, err := svc.GetWorkspaceFile(ctx, "remote", "remote.txt")
	if err != nil || !reflect.DeepEqual(file, remote.file) {
		t.Fatalf("file = %#v, %v", file, err)
	}
	blob, err := svc.GetWorkspaceFileBlob(ctx, "remote", "image.png", WorkspaceBlobAfter)
	if err != nil || !reflect.DeepEqual(blob, remote.blob) {
		t.Fatalf("blob = %#v, %v", blob, err)
	}
	watch, err := svc.WatchWorkspace(ctx, "remote")
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-watch:
	default:
		t.Fatal("remote event was not delegated")
	}
	preview, err := svc.ReadPreviewFile(ctx, "remote", "index.html")
	if err != nil || !reflect.DeepEqual(preview, remote.preview) {
		t.Fatalf("preview = %#v, %v", preview, err)
	}
	entry, ok, err := svc.DiscoverPreview(ctx, "remote")
	if err != nil || !ok || entry != "dist/index.html" {
		t.Fatalf("discover = %q, %v, %v", entry, ok, err)
	}
	svc.InvalidateWorkspaceCache("remote")
	if remote.invalidated != "remote" {
		t.Fatalf("invalidated %q", remote.invalidated)
	}
	wantCalls := []string{"list", "read", "blob", "watch", "preview", "discover", "invalidate"}
	if !reflect.DeepEqual(remote.calls, wantCalls) {
		t.Fatalf("calls = %v, want %v", remote.calls, wantCalls)
	}
}

func TestWorkspaceContentPreservesRemoteErrorsAcrossEveryOperation(t *testing.T) {
	want := errors.New("compute plane unavailable")
	remote := &fakeRemoteObservation{err: want}
	svc := &Service{workspaceObservation: remote}
	ctx := context.Background()
	checks := []func() error{
		func() error { _, err := svc.ListWorkspaceFiles(ctx, "remote"); return err },
		func() error { _, err := svc.GetWorkspaceFile(ctx, "remote", "x"); return err },
		func() error { _, err := svc.GetWorkspaceFileBlob(ctx, "remote", "x", WorkspaceBlobAfter); return err },
		func() error { _, err := svc.WatchWorkspace(ctx, "remote"); return err },
		func() error { _, err := svc.ReadPreviewFile(ctx, "remote", "x"); return err },
		func() error { _, _, err := svc.DiscoverPreview(ctx, "remote"); return err },
	}
	for i, check := range checks {
		if err := check(); !errors.Is(err, want) {
			t.Fatalf("operation %d error = %v", i, err)
		}
	}
}

func TestLocalWorkspaceObservationBoundsAndConfinesPreviewReads(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "ok.txt"), []byte("ok"), 0o600); err != nil {
		t.Fatal(err)
	}
	large := filepath.Join(root, "large.bin")
	file, err := os.Create(large)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(ports.MaxPreviewFileBytes + 1); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(root, "escape.txt")); err != nil {
		t.Skipf("symlink unsupported: %v", err)
	}

	store := newFakeStore()
	store.sessions["remote-safe"] = domain.SessionRecord{
		ID:       "remote-safe",
		Metadata: domain.SessionMetadata{WorkspacePath: root},
	}
	svc := &Service{store: store}

	got, err := svc.ReadPreviewFile(context.Background(), "remote-safe", "ok.txt")
	if err != nil || string(got.Data) != "ok" {
		t.Fatalf("read ok = %#v, %v", got, err)
	}
	for _, path := range []string{"../secret.txt", "escape.txt"} {
		if _, err := svc.ReadPreviewFile(context.Background(), "remote-safe", path); err == nil {
			t.Fatalf("read %q unexpectedly succeeded", path)
		}
	}
	_, err = svc.ReadPreviewFile(context.Background(), "remote-safe", "large.bin")
	var apiError *apierr.Error
	if !errors.As(err, &apiError) || apiError.Code != "PREVIEW_FILE_TOO_LARGE" {
		t.Fatalf("large preview error = %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := svc.ReadPreviewFile(ctx, "remote-safe", "ok.txt"); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled preview error = %v", err)
	}
}
