package browserruntime

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

const workerConnectTimeout = 8 * time.Second

// Managed prefers the visible desktop runtime and lazily starts a hidden
// Electron worker when the daemon was started without an attached desktop.
// Both providers use the same authenticated private broker transport.
type Managed struct {
	ctx    context.Context
	broker *Broker

	mu       sync.Mutex
	starting bool
	lastErr  error
}

// NewManaged wraps a broker with lazy hidden-provider startup.
func NewManaged(ctx context.Context, broker *Broker) *Managed {
	return &Managed{ctx: ctx, broker: broker}
}

// Status reports the connected provider or an in-progress hidden-provider launch.
func (m *Managed) Status() Status {
	status := m.broker.Status()
	if status.Connected {
		return status
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.starting {
		status.State = ReadinessRuntimeConnecting
		status.Provider = "headless-electron"
		status.RecommendedAction = "Wait for the headless browser runtime to connect."
	} else if m.lastErr != nil {
		status.State = ReadinessUnavailable
		status.RecommendedAction = "Open the AO desktop app; the headless browser runtime could not start."
	}
	return status
}

// Ensure makes a browser provider available without exposing a debug port or
// network listener. It is intentionally invoked only by an explicit browser
// API request.
func (m *Managed) Ensure(ctx context.Context) error {
	if m.broker.Status().Connected {
		return nil
	}
	executable := strings.TrimSpace(os.Getenv(WorkerExecutableEnv))
	if executable == "" {
		return ErrUnavailable
	}
	m.mu.Lock()
	if !m.starting {
		m.starting = true
		m.lastErr = nil
		args := make([]string, 0, 2)
		if appPath := strings.TrimSpace(os.Getenv(WorkerAppPathEnv)); appPath != "" {
			args = append(args, appPath)
		}
		args = append(args, "--ao-browser-runtime-worker")
		// The desktop supplies an absolute executable path and no shell is involved.
		cmd := exec.CommandContext(m.ctx, executable, args...) //nolint:gosec // Intentional trusted Electron provider launch.
		cmd.Env = os.Environ()
		cmd.Stdout, cmd.Stderr, cmd.Stdin = io.Discard, io.Discard, nil
		if err := cmd.Start(); err != nil {
			m.starting = false
			m.lastErr = err
			m.mu.Unlock()
			return errors.Join(ErrUnavailable, err)
		}
		go func() {
			err := cmd.Wait()
			m.mu.Lock()
			m.starting = false
			if err != nil && !m.broker.Status().Connected {
				m.lastErr = err
			}
			m.mu.Unlock()
		}()
	}
	m.mu.Unlock()

	timer := time.NewTimer(workerConnectTimeout)
	ticker := time.NewTicker(50 * time.Millisecond)
	defer timer.Stop()
	defer ticker.Stop()
	for {
		if m.broker.Status().Connected {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			return ErrUnavailable
		case <-ticker.C:
		}
	}
}

// Execute dispatches a command, starting the hidden provider when necessary.
func (m *Managed) Execute(ctx context.Context, sessionID domain.SessionID, action string, args map[string]interface{}) (Result, error) {
	result, err := m.broker.Execute(ctx, sessionID, action, args)
	if !errors.Is(err, ErrUnavailable) {
		return result, err
	}
	if err := m.Ensure(ctx); err != nil {
		return Result{}, err
	}
	return m.broker.Execute(ctx, sessionID, action, args)
}

// DestroySession removes live browser resources without starting a provider.
func (m *Managed) DestroySession(ctx context.Context, sessionID domain.SessionID) error {
	return m.broker.DestroySession(ctx, sessionID)
}
