//go:build !windows

package tmux

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestPrivateSocketAddressAliasesLongPathIntoRuntimeDirectory(t *testing.T) {
	targetDir := filepath.Join(t.TempDir(), strings.Repeat("deep-runtime-directory-", 6))
	if err := os.MkdirAll(targetDir, 0o700); err != nil {
		t.Fatal(err)
	}
	socketPath := filepath.Join(targetDir, "tmux-0123456789abcdef0123456789abcdef.sock")
	if len([]byte(socketPath)) <= maxUnixSocketPathBytes {
		t.Fatalf("precondition: socket path is only %d bytes: %q", len([]byte(socketPath)), socketPath)
	}

	address, err := privateSocketAddress(socketPath)
	if err != nil {
		t.Fatal(err)
	}
	aliasDir := filepath.Dir(address)
	t.Cleanup(func() { _ = os.Remove(aliasDir) })
	aliasRoot := filepath.Dir(aliasDir)
	if got, want := aliasRoot, filepath.Join("/tmp", "ao-tmux-"+strconv.Itoa(os.Getuid())); got != want {
		t.Fatalf("alias root = %q, want owner-specific root %q", got, want)
	}
	if info, err := os.Stat(aliasRoot); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("alias root mode = %v, err=%v; want 0700", infoMode(info), err)
	}
	if len([]byte(address)) > maxUnixSocketPathBytes {
		t.Fatalf("aliased socket path is %d bytes, maximum %d: %q", len([]byte(address)), maxUnixSocketPathBytes, address)
	}
	if strings.Contains(address, targetDir) {
		t.Fatalf("aliased socket retained long runtime path: %q", address)
	}
	wantTarget, err := filepath.EvalSymlinks(targetDir)
	if err != nil {
		t.Fatal(err)
	}
	if target, err := os.Readlink(aliasDir); err != nil || target != wantTarget {
		t.Fatalf("alias target = %q, err=%v; want %q", target, err, wantTarget)
	}

	// Creating through the short address must put the inode inside AO's runtime
	// directory, not /tmp. A real tmux bind follows the same parent symlink.
	if err := os.WriteFile(address, []byte("probe"), 0o600); err != nil {
		t.Fatalf("write through alias: %v", err)
	}
	if got, err := os.ReadFile(socketPath); err != nil || string(got) != "probe" {
		t.Fatalf("runtime-dir inode = %q, err=%v; want probe", got, err)
	}
}

func TestPrivateSocketAddressRefusesForeignAlias(t *testing.T) {
	targetDir := filepath.Join(t.TempDir(), strings.Repeat("deep-runtime-directory-", 6))
	foreignDir := t.TempDir()
	if err := os.MkdirAll(targetDir, 0o700); err != nil {
		t.Fatal(err)
	}
	socketPath := filepath.Join(targetDir, "tmux-0123456789abcdef0123456789abcdef.sock")
	address, err := privateSocketAddress(socketPath)
	if err != nil {
		t.Fatal(err)
	}
	aliasDir := filepath.Dir(address)
	if err := os.Remove(aliasDir); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(foreignDir, aliasDir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(aliasDir) })

	if _, err := privateSocketAddress(socketPath); err == nil || !strings.Contains(err.Error(), "points to") {
		t.Fatalf("privateSocketAddress error = %v, want foreign alias rejection", err)
	}
}

func TestEnsureSocketAliasRootRefusesSymlinkAndTightensPermissions(t *testing.T) {
	parent := t.TempDir()
	target := t.TempDir()
	symlinkRoot := filepath.Join(parent, "symlink-root")
	if err := os.Symlink(target, symlinkRoot); err != nil {
		t.Fatal(err)
	}
	if err := ensureSocketAliasRoot(symlinkRoot); err == nil || !strings.Contains(err.Error(), "not a directory") {
		t.Fatalf("symlink root error = %v, want rejection", err)
	}

	looseRoot := filepath.Join(parent, "loose-root")
	if err := os.Mkdir(looseRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(looseRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := ensureSocketAliasRoot(looseRoot); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(looseRoot)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o700 {
		t.Fatalf("secured alias root mode = %o, want 700", got)
	}
}

func TestPrivateSocketAddressRejectsSharedWritableParent(t *testing.T) {
	shared := filepath.Join(t.TempDir(), "shared")
	if err := os.Mkdir(shared, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(shared, 0o777); err != nil {
		t.Fatal(err)
	}

	shortPath := filepath.Join(shared, "tmux.sock")
	if _, err := privateSocketAddress(shortPath); err == nil || !strings.Contains(err.Error(), "writable by other users") {
		t.Fatalf("short private socket error = %v, want shared-parent rejection", err)
	}

	longDir := filepath.Join(shared, strings.Repeat("deep-runtime-directory-", 6))
	if err := os.Mkdir(longDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(longDir, 0o777); err != nil {
		t.Fatal(err)
	}
	longPath := filepath.Join(longDir, "tmux-0123456789abcdef0123456789abcdef.sock")
	if len([]byte(longPath)) <= maxUnixSocketPathBytes {
		t.Fatalf("precondition: long socket path is only %d bytes", len([]byte(longPath)))
	}
	if _, err := privateSocketAddress(longPath); err == nil || !strings.Contains(err.Error(), "writable by other users") {
		t.Fatalf("long private socket error = %v, want shared-parent rejection", err)
	}
}

func infoMode(info os.FileInfo) os.FileMode {
	if info == nil {
		return 0
	}
	return info.Mode().Perm()
}
