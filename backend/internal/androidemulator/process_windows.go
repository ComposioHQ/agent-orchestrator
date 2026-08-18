//go:build windows

package androidemulator

import (
	"fmt"
	"os/exec"
	"strconv"
	"unsafe"

	"golang.org/x/sys/windows"

	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
)

// configureProcAttr is a no-op on Windows: process-tree membership is
// established after Start, in afterSpawn below (a Job Object needs a real
// process handle, which doesn't exist yet at SysProcAttr time).
func configureProcAttr(_ *exec.Cmd) {}

// afterSpawn assigns the freshly-started process to a Windows Job Object
// configured to kill every process ever assigned to it as soon as the job
// handle is closed or TerminateJobObject is called -- regardless of whether
// the originally-spawned process is still alive at that point.
//
// This matters because taskkill /PID <pid> /T (killTree's fallback below)
// requires pid to still exist: confirmed live, the Android emulator's own
// launcher process can exit on its own once its real VM backend
// (qemu-system-x86_64-headless.exe) is confirmed running, rather than
// staying alive as its parent for the whole session. Once that happens,
// taskkill /T has nothing to walk a tree from and fails outright, leaving
// the actual VM backend running forever and holding the AVD's lock files --
// the next boot then fails with "Running multiple emulators with the same
// AVD". A Job Object has no such requirement: every process ever assigned to
// it, including ones whose original parent has since exited, is tracked by
// the OS and terminated together.
func afterSpawn(cmd *exec.Cmd) (any, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, fmt.Errorf("androidemulator: create job object: %w", err)
	}

	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{
			LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
		},
	}
	//nolint:gosec // G103: passing a Go struct's address as a syscall buffer is the standard golang.org/x/sys/windows pattern for *InformationJobObject; info stays alive on this frame for the duration of the call
	if _, err := windows.SetInformationJobObject(
		job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)),
	); err != nil {
		_ = windows.CloseHandle(job)
		return nil, fmt.Errorf("androidemulator: configure job object: %w", err)
	}

	// Open our own handle to the child rather than reusing exec.Cmd's
	// internal one (not exposed): AssignProcessToJobObject needs a real
	// process handle, not just the PID.
	procHandle, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid)) //nolint:gosec // G115: a live OS PID is never negative
	if err != nil {
		_ = windows.CloseHandle(job)
		return nil, fmt.Errorf("androidemulator: open process %d: %w", cmd.Process.Pid, err)
	}
	defer func() { _ = windows.CloseHandle(procHandle) }()

	if err := windows.AssignProcessToJobObject(job, procHandle); err != nil {
		_ = windows.CloseHandle(job)
		return nil, fmt.Errorf("androidemulator: assign process %d to job object: %w", cmd.Process.Pid, err)
	}
	return job, nil
}

// killTree terminates pid and every descendant process. killData, if it's
// the windows.Handle afterSpawn returned, is a Job Object covering the whole
// tree regardless of whether pid itself is still alive (see afterSpawn) --
// tried first. taskkill /PID pid /T /F runs unconditionally alongside it as
// a defense-in-depth fallback (e.g. if afterSpawn failed and killData is
// nil): harmless if pid is already gone, and still correct on its own for
// the common case where pid is still alive when Kill is called.
func killTree(pid int, killData any) error {
	var jobErr error
	if job, ok := killData.(windows.Handle); ok {
		jobErr = windows.TerminateJobObject(job, 1)
		_ = windows.CloseHandle(job)
	}

	taskkillErr := aoprocess.Command("taskkill", "/PID", strconv.Itoa(pid), "/T", "/F").Run()
	if jobErr == nil || taskkillErr == nil {
		return nil
	}
	return fmt.Errorf("androidemulator: kill process tree for pid %d: job object: %w; taskkill: %w", pid, jobErr, taskkillErr)
}
