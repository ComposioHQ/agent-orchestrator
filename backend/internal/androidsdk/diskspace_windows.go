//go:build windows

package androidsdk

import (
	"fmt"

	"golang.org/x/sys/windows"
)

// FreeBytes returns the number of free bytes available to the current user
// on the volume containing path.
func FreeBytes(path string) (uint64, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, fmt.Errorf("androidsdk: encode path %s: %w", path, err)
	}
	var freeBytesAvailable, totalBytes, totalFreeBytes uint64
	if err := windows.GetDiskFreeSpaceEx(p, &freeBytesAvailable, &totalBytes, &totalFreeBytes); err != nil {
		return 0, fmt.Errorf("androidsdk: GetDiskFreeSpaceEx %s: %w", path, err)
	}
	return freeBytesAvailable, nil
}
