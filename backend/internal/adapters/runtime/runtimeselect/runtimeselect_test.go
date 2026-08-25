//go:build !windows

package runtimeselect

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"testing"
)

func TestPrivateTmuxSocketPathDerivesStableAbsolutePathFromFullRunFileIdentity(t *testing.T) {
	dir := t.TempDir()
	firstRunFile := filepath.Join(dir, "running.json")
	secondRunFile := filepath.Join(dir, "development.json")

	first := privateTmuxSocketPath(firstRunFile)
	if !filepath.IsAbs(first) {
		t.Fatalf("socket path = %q, want absolute", first)
	}
	if again := privateTmuxSocketPath(firstRunFile); again != first {
		t.Fatalf("socket path changed for the same run file: first %q, again %q", first, again)
	}

	digest := sha256.Sum256([]byte(firstRunFile))
	want := filepath.Join(dir, "tmux-"+hex.EncodeToString(digest[:tmuxSocketIdentityBytes])+".sock")
	if first != want {
		t.Fatalf("socket path = %q, want %q", first, want)
	}

	second := privateTmuxSocketPath(secondRunFile)
	if second == first {
		t.Fatalf("run files in the same directory shared socket %q", first)
	}
}

func TestPrivateTmuxSocketPathAbsolutizesRelativeRunFile(t *testing.T) {
	got := privateTmuxSocketPath(filepath.Join("state", "running.json"))
	if !filepath.IsAbs(got) {
		t.Fatalf("socket path = %q, want absolute", got)
	}
}

func TestPrivateTmuxSocketPathFailsClosedWithoutRunFileIdentity(t *testing.T) {
	if got := privateTmuxSocketPath(""); got != "" {
		t.Fatalf("socket path = %q, want empty fail-closed path", got)
	}
}
