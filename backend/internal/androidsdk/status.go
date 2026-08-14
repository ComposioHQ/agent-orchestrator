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
// already on disk under toolsDir: installed if AO's own managed install or
// a previously-adopted external SDK (see UseExternal) is present and still
// valid, not_installed otherwise. Checking through Installed (rather than
// just the AO-managed manifest) is what makes an external SDK adoption
// survive a daemon restart.
func NewManager(toolsDir string) *Manager {
	state := StateNotInstalled
	if _, ok := Installed(toolsDir); ok {
		state = StateInstalled
	}
	return &Manager{toolsDir: toolsDir, state: state}
}

// Status returns the current install state and, while downloading, per
// component progress. If the state was Installed but the underlying SDK
// (AO-managed or external) no longer validates -- most likely an adopted
// external SDK whose Android Studio install was since removed -- this
// self-heals the in-memory state back to StateNotInstalled rather than
// keep reporting a source that can no longer boot.
func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.state == StateInstalled {
		if _, ok := Installed(m.toolsDir); !ok {
			m.state = StateNotInstalled
		}
	}
	s := Status{State: m.state, Error: m.lastErr}
	for _, p := range m.progress {
		s.Components = append(s.Components, p)
	}
	return s
}

// UseExternal adopts an already-detected external SDK in place of
// downloading AO's own managed copy: records d as the installed SDK
// (surviving future NewManager calls, see above) and transitions to
// StateInstalled. Guarded only by m.running -- the same, sole guard
// StartInstall uses, and provably equivalent to a full state check since
// running and state=StateDownloading are always set and cleared together in
// the same critical sections. Allowed from any other state (not_installed,
// installed, or failed), matching StartInstall's own laxness about
// overwriting a prior install.
func (m *Manager) UseExternal(d DetectedSDK) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.running {
		return errInstallAlreadyRunning
	}
	if err := writeExternalSDKRecord(m.toolsDir, d); err != nil {
		return err
	}
	m.state = StateInstalled
	m.lastErr = ""
	return nil
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
