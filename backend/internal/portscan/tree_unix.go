//go:build !windows

package portscan

import (
	"context"
	"time"

	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
)

// processTableTimeout bounds the snapshot. A stalled `ps` must never hold a
// preview request open.
const processTableTimeout = 2 * time.Second

// processTable snapshots the machine's processes. `ps` rather than /proc even
// on Linux: one exec per scan is cheap next to reading a stat file for every
// pid on the machine, and it is the same invocation the tmux runtime already
// uses for its own process-tree work.
func processTable(ctx context.Context) []process {
	tableCtx, cancel := context.WithTimeout(ctx, processTableTimeout)
	defer cancel()
	out, err := aoprocess.CommandContext(tableCtx, "ps", "-ww", "-axo", "pid=,ppid=,args=").Output()
	if err != nil && len(out) == 0 {
		return nil
	}
	return parseProcessTable(string(out))
}
