package androidemulator

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"sync"
)

// maxBufferedPartialBytes bounds an in-flight, not-yet-newline-terminated
// log line, mirroring previewserver's lineBuffer.
const maxBufferedPartialBytes = 4096

// lineBuffer is a bounded ring buffer of a process's recent stdout/stderr
// lines, safe for concurrent use as an io.Writer target and a concurrent
// reader via Last. Mirrors previewserver.lineBuffer (unexported there, so
// reimplemented rather than imported).
type lineBuffer struct {
	mu      sync.Mutex
	max     int
	lines   []string
	partial string
}

func newLineBuffer(capacity int) *lineBuffer {
	return &lineBuffer{max: capacity}
}

func (b *lineBuffer) Write(data []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	text := b.partial + string(data)
	parts := strings.Split(text, "\n")
	b.partial = parts[len(parts)-1]
	if len(b.partial) > maxBufferedPartialBytes {
		b.partial = b.partial[len(b.partial)-maxBufferedPartialBytes:]
	}
	for _, line := range parts[:len(parts)-1] {
		b.appendLocked(strings.TrimSuffix(line, "\r"))
	}
	return len(data), nil
}

func (b *lineBuffer) Last(limit int) []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	lines := append([]string{}, b.lines...)
	if b.partial != "" {
		lines = append(lines, b.partial)
	}
	if len(lines) > limit {
		lines = lines[len(lines)-limit:]
	}
	return lines
}

func (b *lineBuffer) appendLocked(line string) {
	b.lines = append(b.lines, line)
	if len(b.lines) > b.max {
		b.lines = append([]string{}, b.lines[len(b.lines)-b.max:]...)
	}
}

// defaultLogBufferLines bounds how many recent lines Process retains.
const defaultLogBufferLines = 500

// SpawnConfig describes how to launch and supervise a subprocess. Command/Args
// are split out (rather than one flat command string) to avoid any shell
// interpretation of AVD names or paths.
type SpawnConfig struct {
	// Ctx, if set, is used to kill the process when cancelled (in addition to
	// explicit Kill calls). Defaults to context.Background() (no auto-kill).
	Ctx     context.Context
	Command string
	Args    []string
	// Env entries are appended to the child's environment (not a replacement
	// of it -- the child still inherits the parent's PATH etc.).
	Env []string
}

// Process supervises one running subprocess: spawn, bounded log capture, and
// exit detection. It has no restart logic of its own -- that's Manager's
// job, layered on top so retry/backoff policy stays out of the low-level
// spawn mechanics.
type Process struct {
	cmd  *exec.Cmd
	logs *lineBuffer

	waitOnce sync.Once
	waitErr  error
}

// Spawn starts the subprocess described by cfg, capturing its combined
// stdout/stderr into a bounded log buffer. It does not wait for the process
// to become ready (e.g. for the emulator, boot completion) -- callers poll
// readiness separately (ADB/gRPC), matching the real emulator's own
// asynchronous boot behavior confirmed during the A0 spike.
func Spawn(cfg SpawnConfig) (*Process, error) {
	ctx := cfg.Ctx
	if ctx == nil {
		ctx = context.Background()
	}
	cmd := exec.CommandContext(ctx, cfg.Command, cfg.Args...)
	if len(cfg.Env) > 0 {
		cmd.Env = append(cmd.Environ(), cfg.Env...)
	}
	logs := newLineBuffer(defaultLogBufferLines)
	cmd.Stdout = logs
	cmd.Stderr = logs

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("androidemulator: spawn %s: %w", cfg.Command, err)
	}
	return &Process{cmd: cmd, logs: logs}, nil
}

// Wait blocks until the process exits, returning a non-nil error for a
// nonzero exit (mirroring exec.Cmd.Wait's own contract). Safe to call from
// multiple goroutines concurrently (Manager's crash-watcher and an explicit
// Stop may both call it) -- the underlying exec.Cmd.Wait is not documented
// as safe for concurrent multi-caller use, so the result is memoized and
// the real Wait runs at most once.
func (p *Process) Wait() error {
	p.waitOnce.Do(func() {
		p.waitErr = p.cmd.Wait()
	})
	return p.waitErr
}

// Logs returns up to the last `limit` captured lines.
func (p *Process) Logs(limit int) []string {
	return p.logs.Last(limit)
}

// Kill terminates the process immediately (no graceful shutdown signal --
// the emulator's own state is disposable/re-creatable, so there's nothing to
// flush).
func (p *Process) Kill() error {
	if p.cmd.Process == nil {
		return nil
	}
	return p.cmd.Process.Kill()
}

// Pid returns the OS process id, or 0 if the process has not started.
func (p *Process) Pid() int {
	if p.cmd.Process == nil {
		return 0
	}
	return p.cmd.Process.Pid
}
