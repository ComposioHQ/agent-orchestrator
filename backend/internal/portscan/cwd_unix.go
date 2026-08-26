//go:build !linux && !windows

package portscan

import (
	"context"
	"strconv"
	"strings"
	"time"

	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
)

// cwdTimeout bounds the lookup; a stalled lsof must not hold a request open.
const cwdTimeout = 2 * time.Second

// workspaceProcesses lists processes whose working directory is inside
// workspace. There is no /proc on macOS, so one lsof asks for the cwd
// descriptor of every process in the table at once rather than per process.
func workspaceProcesses(ctx context.Context, procs []process, workspace string) []int {
	if workspace == "" || len(procs) == 0 {
		return nil
	}
	list := make([]string, 0, len(procs))
	for _, proc := range procs {
		list = append(list, strconv.Itoa(proc.PID))
	}
	cwdCtx, cancel := context.WithTimeout(ctx, cwdTimeout)
	defer cancel()
	out, err := aoprocess.CommandContext(
		cwdCtx, "lsof", "-a", "-d", "cwd", "-p", strings.Join(list, ","), "-F", "pn",
	).Output()
	if err != nil && len(out) == 0 {
		return nil
	}
	return parseCwdListing(string(out), workspace)
}

// parseCwdListing reads lsof -F field output, where a "p" line opens a process
// block and the following "n" line is that process's working directory.
func parseCwdListing(out, workspace string) []int {
	var pids []int
	pid := 0
	for _, line := range strings.Split(out, "\n") {
		if len(line) < 2 {
			continue
		}
		value := strings.TrimSpace(line[1:])
		switch line[0] {
		case 'p':
			pid = 0
			if parsed, err := strconv.Atoi(value); err == nil && parsed > 0 {
				pid = parsed
			}
		case 'n':
			if pid > 0 && underWorkspace(value, workspace) {
				pids = append(pids, pid)
				pid = 0
			}
		}
	}
	return pids
}
