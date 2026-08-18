//go:build windows

package androidemulator

import "golang.org/x/sys/windows"

// stillActive is the well-known Win32 STILL_ACTIVE sentinel (259), not
// exported by golang.org/x/sys/windows.
const stillActive = 259

// processAlive reports whether pid still identifies a live process. Used only
// to prove Kill() reaches a grandchild process, not for production liveness
// checks -- see previewserver's identical use of OpenProcess for the same
// existence-check idiom on Windows.
func processAlive(pid int) bool {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer func() { _ = windows.CloseHandle(handle) }()
	var exitCode uint32
	if err := windows.GetExitCodeProcess(handle, &exitCode); err != nil {
		return false
	}
	return exitCode == stillActive
}
