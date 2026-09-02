package acp

import (
	"errors"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/chatdriver/processenv"
)

// stderrTailLimit bounds the retained adapter stderr. A runtime that dies on
// startup prints a multi-frame fatal trace; keeping the tail captures the fatal
// message without letting a chatty adapter grow the buffer without bound.
const stderrTailLimit = 8 << 10

// stderrTailWait bounds how long a caller blocks for the drain goroutine to see
// EOF. The adapter has normally already exited by the time the tail is read.
const stderrTailWait = 250 * time.Millisecond

type process struct {
	stdin  io.WriteCloser
	stdout io.Reader
	// stderrTail returns the retained tail of the adapter's stderr. An adapter
	// that dies before answering a request reports why here and nowhere else,
	// so the handshake path folds it into the returned error.
	stderrTail func() string
	stop       func() error
}

// stderrSnapshot reads the retained stderr tail, tolerating the zero-value
// process used by tests that fake the transport.
func (p *process) stderrSnapshot() string {
	if p == nil || p.stderrTail == nil {
		return ""
	}
	return p.stderrTail()
}

// tailBuffer retains the last stderrTailLimit bytes written to it.
type tailBuffer struct {
	mu  sync.Mutex
	buf []byte
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > stderrTailLimit {
		t.buf = append([]byte(nil), t.buf[len(t.buf)-stderrTailLimit:]...)
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.buf)
}

type spawnFunc func(Launch, string) (*process, error)

func spawnAgent(launch Launch, workdir string) (*process, error) {
	cmd := exec.Command(launch.Command, launch.Args...)
	cmd.Dir = workdir
	cmd.Env = processenv.Merge(launch.Env)
	configureProcessGroup(cmd)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("stderr pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start %s: %w", launch.Command, err)
	}

	// ACP owns stdout. Always drain stderr separately so a verbose adapter cannot
	// fill its OS pipe and deadlock the protocol. The tail is retained rather
	// than discarded: when the adapter crashes before completing the ACP
	// handshake, its stderr is the only account of the failure (#4442).
	tail := &tailBuffer{}
	drained := make(chan struct{})
	go func() {
		defer close(drained)
		_, _ = io.Copy(tail, stderr)
	}()

	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	var once sync.Once
	return &process{
		stdin:  stdin,
		stdout: stdout,
		stderrTail: func() string {
			select {
			case <-drained:
			case <-time.After(stderrTailWait):
			}
			return tail.String()
		},
		stop: func() error {
			var stopErr error
			once.Do(func() {
				_ = stdin.Close()
				select {
				case err := <-done:
					stopErr = processExitError(err)
				case <-time.After(3 * time.Second):
					stopErr = killProcessTree(cmd)
					select {
					case <-done:
					case <-time.After(2 * time.Second):
						if stopErr == nil {
							stopErr = errors.New("ACP process did not exit after kill")
						}
					}
				}
			})
			return stopErr
		},
	}, nil
}

func processExitError(err error) error {
	if err == nil {
		return nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		// A provider that exits during shutdown has already released its resources.
		return nil
	}
	return err
}
