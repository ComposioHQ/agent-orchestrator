//go:build !windows

package agent

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"syscall"

	"golang.org/x/sys/unix"
)

func ownedByCurrentUser(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	euid := os.Geteuid()
	return ok && euid >= 0 && uint64(stat.Uid) == uint64(euid)
}

func codexFileOwnerID(info os.FileInfo) (uint32, bool) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return stat.Uid, ok
}

func hasSingleHardLink(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Nlink == 1
}

func openCodexFileNoFollow(path string) (*os.File, error) {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil || stat.Uid != uint32(os.Geteuid()) || stat.Nlink != 1 || stat.Mode&unix.S_IFMT != unix.S_IFREG {
		_ = unix.Close(fd)
		return nil, errors.New("codex file handle is unsafe")
	}
	return os.NewFile(uintptr(fd), filepath.Base(path)), nil
}

func codexPrivateFileMode(info os.FileInfo) bool {
	return info.Mode().Perm()&0o077 == 0
}

func protectCodexPrivateDirectory(path string) error {
	return os.Chmod(path, 0o700) //nolint:gosec // credential directories must be owner-only.
}

func protectCodexPrivateFile(_ string, file *os.File) error {
	return file.Chmod(0o600)
}

func validateCodexDirectory(path string, requirePrivate bool) error {
	if err := validateCodexDirectoryAncestors(path); err != nil {
		return err
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return errors.New("codex directory path is invalid")
	}
	info, err := os.Lstat(abs)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || !ownedByCurrentUser(info) {
		return errors.New("codex directory is unsafe")
	}
	if requirePrivate && info.Mode().Perm() != 0o700 {
		return errors.New("codex directory is not private")
	}
	return nil
}

func validateCodexDirectoryAncestors(path string) error {
	return validateCodexDirectoryAncestorsWith(path, os.Lstat, uint32(os.Geteuid()))
}

func validateCodexDirectoryAncestorsWith(path string, lstat func(string) (os.FileInfo, error), currentUID uint32) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return errors.New("codex directory path is invalid")
	}
	for current := abs; ; current = filepath.Dir(current) {
		info, statErr := lstat(current)
		if errors.Is(statErr, os.ErrNotExist) {
			if parent := filepath.Dir(current); parent != current {
				continue
			}
			return errors.New("codex directory has no trusted ancestor")
		}
		if statErr != nil {
			return errors.New("codex directory has an unsafe ancestor")
		}
		owner, ownerOK := codexFileOwnerID(info)
		if !ownerOK || (owner != currentUID && owner != 0) {
			return errors.New("codex directory has an untrusted owner")
		}
		if info.Mode()&os.ModeSymlink != 0 {
			resolved, trusted := trustedDarwinDirectoryAlias(current, owner)
			if !trusted {
				return errors.New("codex directory has an unsafe ancestor")
			}
			return validateCodexDirectoryAncestorsWith(resolved, lstat, currentUID)
		}
		if !info.IsDir() {
			return errors.New("codex directory has an unsafe ancestor")
		}
		writable := info.Mode().Perm()&0o022 != 0
		safeStickyRoot := owner == 0 && info.Mode()&os.ModeSticky != 0
		if writable && !safeStickyRoot {
			return errors.New("codex directory has a writable ancestor")
		}
		if parent := filepath.Dir(current); parent == current {
			return nil
		}
	}
}

func trustedDarwinDirectoryAlias(path string, owner uint32) (string, bool) {
	if runtime.GOOS != "darwin" || owner != 0 {
		return "", false
	}
	want := map[string]string{"/var": "private/var", "/tmp": "private/tmp"}[path]
	if want == "" {
		return "", false
	}
	target, err := os.Readlink(path)
	if err != nil || target != want {
		return "", false
	}
	return filepath.Join("/", target), true
}

func syncDirectory(path string) error {
	dir, err := os.Open(path) //nolint:gosec // verified private directory.
	if err != nil {
		return err
	}
	defer func() { _ = dir.Close() }()
	return dir.Sync()
}
