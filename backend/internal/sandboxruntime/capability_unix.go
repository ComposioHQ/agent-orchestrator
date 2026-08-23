//go:build unix

package sandboxruntime

import (
	"errors"
	"fmt"
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

func openCapabilityFile(path string) (*os.File, os.FileInfo, uint32, error) {
	before, err := os.Lstat(path)
	if err != nil {
		return nil, nil, 0, fmt.Errorf("open sandbox capability: %w", err)
	}
	if before.Mode()&os.ModeSymlink != 0 {
		return nil, nil, 0, fmt.Errorf("%w: symlinks are forbidden", ErrCapabilityInsecure)
	}

	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		if errors.Is(err, unix.ELOOP) {
			return nil, nil, 0, fmt.Errorf("%w: symlinks are forbidden", ErrCapabilityInsecure)
		}
		return nil, nil, 0, fmt.Errorf("open sandbox capability: %w", err)
	}
	file := os.NewFile(uintptr(fd), path)
	if file == nil {
		_ = unix.Close(fd)
		return nil, nil, 0, errors.New("open sandbox capability: invalid file descriptor")
	}

	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, nil, 0, fmt.Errorf("stat sandbox capability: %w", err)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		_ = file.Close()
		return nil, nil, 0, fmt.Errorf("%w: owner is unavailable", ErrCapabilityInsecure)
	}
	return file, info, stat.Uid, nil
}
