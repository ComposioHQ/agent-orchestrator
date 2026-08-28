//go:build linux

package portscan

import (
	"context"
	"os"
	"strconv"
)

// workspaceProcesses lists processes whose working directory is inside
// workspace. /proc/<pid>/cwd is a symlink the kernel maintains, so this is one
// readlink per process and needs no subprocess. An unreadable link (the process
// exited mid-scan, or belongs to another user) contributes nothing.
func workspaceProcesses(_ context.Context, procs []process, workspace string) []int {
	if workspace == "" {
		return nil
	}
	var pids []int
	for _, proc := range procs {
		cwd, err := os.Readlink("/proc/" + strconv.Itoa(proc.PID) + "/cwd")
		if err != nil {
			continue
		}
		if underWorkspace(cwd, workspace) {
			pids = append(pids, proc.PID)
		}
	}
	return pids
}
