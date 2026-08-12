package androidsdk

import (
	"context"
	"errors"
	"sync"
	"time"
)

// installTimeout bounds the background download so a stalled connection
// cannot hang forever — generous for a ~2GB fetch over a slow link, but
// finite. See StartInstall for why this isn't a caller-supplied context.
const installTimeout = 30 * time.Minute

// State is the lifecycle state of an Android SDK install managed by Manager.
type State string

// Manager's SDK install lifecycle states, in the order a normal
// install/failure cycle visits them.
const (
	StateNotInstalled State = "not_installed"
	StateDownloading  State = "downloading"
	StateInstalled    State = "installed"
	StateFailed       State = "failed"
)

// ComponentProgress reports download progress for one SDK component.
type ComponentProgress struct {
	Component  string
	BytesDone  int64
	BytesTotal int64
}

// Status is a point-in-time snapshot of a Manager's install state.
type Status struct {
	State      State
	Components []ComponentProgress
	Error      string
}

// Manager tracks the lifecycle of a single Android SDK install: whether one
// is installed, in progress, or failed, and lets a caller (the HTTP
// controller) kick off an install that runs in the background while Status
// is polled for progress.
type Manager struct {
	mu       sync.Mutex
	toolsDir string
	state    State
	progress map[string]ComponentProgress
	lastErr  string
	running  bool
}

// NewManager builds a Manager whose initial state reflects whatever is
// already on disk under toolsDir (installed if a matching version manifest
// is present, not_installed otherwise).
func NewManager(toolsDir string) *Manager {
	state := StateNotInstalled
	if _, ok := readInstalledManifest(toolsDir); ok {
		state = StateInstalled
	}
	return &Manager{toolsDir: toolsDir, state: state}
}

// Status returns the current install state and, while downloading, per
// component progress.
func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := Status{State: m.state, Error: m.lastErr}
	for _, p := range m.progress {
		s.Components = append(s.Components, p)
	}
	return s
}

// StartInstall kicks off Install in the background and returns immediately;
// poll Status for progress and the final installed/failed outcome. Returns an
// error synchronously only if an install is already running.
//
// The download runs on its own timeout-bounded context, not a caller-supplied
// one. The real caller is an HTTP handler (POST /android-device/sdk/setup)
// that hands off and returns immediately; net/http cancels that request's
// context the moment the handler returns, which would otherwise abort the
// still-running, multi-minute download out from under the caller.
func (m *Manager) StartInstall(cfg InstallConfig) error {
	m.mu.Lock()
	if m.running {
		m.mu.Unlock()
		return errInstallAlreadyRunning
	}
	m.running = true
	m.state = StateDownloading
	m.progress = make(map[string]ComponentProgress)
	m.lastErr = ""
	m.mu.Unlock()

	cfg.Progress = func(component string, p DownloadProgress) {
		m.mu.Lock()
		m.progress[component] = ComponentProgress{Component: component, BytesDone: p.BytesDone, BytesTotal: p.BytesTotal}
		m.mu.Unlock()
	}

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), installTimeout)
		defer cancel()
		err := Install(ctx, cfg)
		m.mu.Lock()
		defer m.mu.Unlock()
		m.running = false
		if err != nil {
			m.state = StateFailed
			m.lastErr = err.Error()
			return
		}
		m.state = StateInstalled
	}()
	return nil
}

var errInstallAlreadyRunning = errors.New("androidsdk: install already in progress")
