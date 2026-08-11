//go:build !windows

package androidsdk

import (
	"fmt"
	"syscall"
)

// FreeBytes returns the number of free bytes available to the current user
// on the filesystem containing path.
func FreeBytes(path string) (uint64, error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, fmt.Errorf("androidsdk: statfs %s: %w", path, err)
	}
	return uint64(stat.Bavail) * uint64(stat.Bsize), nil
}
