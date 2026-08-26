// Package runtimeselect picks the correct runtime backend by platform:
// tmux on Darwin/Linux, conpty (ConPTY) on Windows.
package runtimeselect

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"path/filepath"
	"runtime"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/runtime/conpty"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/runtime/tmux"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Runtime is the union interface that both tmux and conpty satisfy.
// It extends ports.Runtime (Create/Destroy/IsAlive) with the additional methods
// the daemon wires directly, including ports.Attacher (Attach) so the terminal
// layer can open a Stream against the selected runtime.
type Runtime interface {
	ports.Runtime // Create, Destroy, IsAlive
	ports.Attacher
	Interrupt(ctx context.Context, handle ports.RuntimeHandle) error
	SendInput(ctx context.Context, handle ports.RuntimeHandle, input string) error
	SendMessage(ctx context.Context, handle ports.RuntimeHandle, message string) error
	GetOutput(ctx context.Context, handle ports.RuntimeHandle, lines int) (string, error)
}

// Compile-time assertions: both adapters must implement the union interface.
var _ Runtime = (*tmux.Runtime)(nil)
var _ Runtime = (*conpty.Runtime)(nil)

// New returns the per-platform runtime: tmux on Darwin/Linux, conpty on
// Windows. log is accepted for signature stability with callers but is
// currently unused. runFilePath is this daemon instance's running.json path
// (config.Config.RunFilePath): on Darwin/Linux it identifies the private tmux
// socket, and on Windows it scopes the conpty pty-host registry to the same
// instance. Two AO daemons with different run files therefore never share
// terminal runtime state.
func New(_ *slog.Logger, runFilePath string) Runtime {
	if runtime.GOOS != "windows" {
		return tmux.New(tmux.Options{
			SocketPath:  privateTmuxSocketPath(runFilePath),
			RunFilePath: runFilePath,
		})
	}
	return conpty.New(conpty.Options{RunFilePath: runFilePath})
}

const tmuxSocketIdentityBytes = 16

// privateTmuxSocketPath gives each daemon identity its own explicit tmux
// server. Config.Load resolves runFilePath to an absolute path; Abs also keeps
// direct callers and tests on that same contract. Hashing the full path (not
// merely its directory) prevents two AO run files beside each other from
// sharing a server accidentally. The tmux adapter presents overly long paths
// through a bounded /tmp directory alias while keeping the socket inode here,
// beside the run file.
func privateTmuxSocketPath(runFilePath string) string {
	if runFilePath == "" {
		// Runtime operations will fail closed on the empty socket path instead of
		// placing terminal state relative to the daemon's incidental cwd.
		return ""
	}
	absRunFilePath, err := filepath.Abs(runFilePath)
	if err != nil {
		// An already-absolute path never needs the working directory and cannot
		// hit this branch. Keep the helper deterministic for an invalid direct
		// caller; production receives config.Config.RunFilePath, which is absolute.
		absRunFilePath = filepath.Clean(runFilePath)
	}
	digest := sha256.Sum256([]byte(absRunFilePath))
	identity := hex.EncodeToString(digest[:tmuxSocketIdentityBytes])
	return filepath.Join(filepath.Dir(absRunFilePath), "tmux-"+identity+".sock")
}
