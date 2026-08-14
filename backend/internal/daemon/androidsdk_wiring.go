package daemon

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/androidemulator"
	"github.com/aoagents/agent-orchestrator/backend/internal/androidsdk"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/controllers"
)

// Fixed download targets for AO's managed Android SDK. These are AO's own
// choice, not something an HTTP caller can influence — the setup endpoint's
// only caller-supplied input is license consent (see androidDeviceService.Setup).
const (
	androidRepositoryManifestURL = "https://dl.google.com/android/repository/repository2-3.xml"
	androidDownloadBaseURL       = "https://dl.google.com/android/repository/"
	// androidDefaultAPILevel/Tag select one fixed default device profile for
	// v1 (no device/API-level picker UI), matching the API level verified
	// against the real manifest during the A0 spike.
	androidDefaultAPILevel = 34
	androidDefaultTag      = "google_apis"

	// androidAVDName is AO's single managed device's fixed AVD id.
	androidAVDName = "ao-default"
	// androidGRPCPort matches the port used throughout the A0 spike.
	androidGRPCPort = 8554
	// androidDeviceSerial is deterministic given AO ever runs at most one
	// managed emulator instance: the Android emulator always claims port
	// 5554/serial emulator-5554 for the first (and here, only) instance,
	// confirmed via `adb devices` during the A0 spike.
	androidDeviceSerial = "emulator-5554"

	androidReadyPollInterval = 2 * time.Second
	androidReadyTimeout      = 3 * time.Minute // cold boot can be slow; quick-boot is much faster once a valid snapshot exists

	// androidFramePollInterval matches the real, measured cadence from the
	// A0 spike: active getScreenshot polling achieved ~4.7fps (~212ms/frame)
	// on this machine. 200ms is a deliberate, conservative middle value.
	androidFramePollInterval = 200 * time.Millisecond
)

// androidRestartBackoff bounds auto-restart attempts after an unexpected
// crash: three tries with increasing delay, then stay Crashed until an
// explicit Start (surfaced to the user rather than restart-looping forever).
var androidRestartBackoff = []time.Duration{5 * time.Second, 15 * time.Second, 30 * time.Second}

func androidSysImgManifestURL(tag string) string {
	return "https://dl.google.com/android/repository/sys-img/" + tag + "/sys-img2-3.xml"
}

func androidSysImgDownloadBaseURL(tag string) string {
	return "https://dl.google.com/android/repository/sys-img/" + tag + "/"
}

// androidDeviceService adapts androidsdk.Manager to controllers.AndroidDeviceService,
// closing over AO's fixed manifest/download URLs, host platform, and target
// API level/tag so the HTTP layer's only variable input is license consent.
type androidDeviceService struct {
	manager         *androidsdk.Manager
	client          *http.Client
	plat            androidsdk.Platform
	toolsDir        string
	emulatorManager *androidemulator.Manager

	// emuClient/frameRelay/inputProxy are lazily connected on first use
	// (SubscribeFrames/SendInput), not at StartDevice time: gRPC's
	// ClientConn reconnects on its own across the emulator's crash-restart
	// cycles as long as it keeps listening on the same fixed port, so one
	// connection dialed once outlives any single boot.
	connMu     sync.Mutex
	emuClient  *androidemulator.EmulatorClient
	frameRelay *androidemulator.FrameRelay
	inputProxy *androidemulator.InputProxy
}

// newAndroidDeviceService builds the service, or returns an error if this
// host has no supported Android emulator build (e.g. windows/arm64,
// linux/arm64 — see androidsdk.DetectPlatform). Callers must treat that as
// non-fatal to daemon boot: the feature is optional, and its absence should
// degrade the controller to nil (501), not refuse to start the daemon.
func newAndroidDeviceService(toolsDir string) (*androidDeviceService, error) {
	plat, err := androidsdk.HostPlatform()
	if err != nil {
		return nil, fmt.Errorf("android device service unavailable: %w", err)
	}
	return &androidDeviceService{
		manager:         androidsdk.NewManager(toolsDir),
		client:          &http.Client{}, // no per-request timeout: the download is large and long-running, bounded by StartInstall's own timeout context instead
		plat:            plat,
		toolsDir:        toolsDir,
		emulatorManager: androidemulator.NewManager(),
	}, nil
}

func (s *androidDeviceService) Status() controllers.AndroidSDKStatusResponse {
	st := s.manager.Status()
	resp := controllers.AndroidSDKStatusResponse{State: string(st.State), Error: st.Error}
	for _, c := range st.Components {
		resp.Components = append(resp.Components, controllers.AndroidSDKComponentProgress{
			Component: c.Component, BytesDone: c.BytesDone, BytesTotal: c.BytesTotal,
		})
	}
	switch st.State {
	case androidsdk.StateNotInstalled, androidsdk.StateFailed:
		if d, ok := androidsdk.DetectExisting(s.candidateRoots(), s.plat.SysImgABI); ok {
			resp.Detected = &controllers.AndroidSDKDetectedInfo{
				Root: d.Root, APILevel: d.SystemImage.APILevel, Tag: d.SystemImage.Tag, ABI: d.SystemImage.ABI,
			}
		}
	case androidsdk.StateInstalled:
		if sdk, ok := androidsdk.Installed(s.toolsDir); ok {
			resp.Source = sdk.Source
		}
	case androidsdk.StateDownloading:
		// Nothing to add: downloading is unambiguous about source (always
		// AO's own managed copy) and there's nothing useful to detect while
		// a download is already in flight.
	}
	return resp
}

func (s *androidDeviceService) Setup(_ context.Context, acceptLicenses bool) error {
	return s.manager.StartInstall(androidsdk.InstallConfig{
		Client:                s.client,
		RepositoryManifestURL: androidRepositoryManifestURL,
		SysImgManifestURL:     androidSysImgManifestURL(androidDefaultTag),
		DownloadBaseURL:       androidDownloadBaseURL,
		SysImgDownloadBaseURL: androidSysImgDownloadBaseURL(androidDefaultTag),
		ToolsDir:              s.toolsDir,
		Platform:              s.plat,
		APILevel:              androidDefaultAPILevel,
		Tag:                   androidDefaultTag,
		AcceptLicenses:        acceptLicenses,
	})
}

// candidateRoots builds the OS/env-derived list of places an existing
// Android SDK might already live, excluding AO's own managed directory --
// otherwise an interrupted, manifest-less partial AO download could be
// "detected" as an external SDK pointing right back at itself.
func (s *androidDeviceService) candidateRoots() []string {
	home, _ := os.UserHomeDir()
	roots := androidsdk.DefaultCandidateRoots(runtime.GOOS, home, os.Getenv("LOCALAPPDATA"), os.Getenv("ANDROID_HOME"), os.Getenv("ANDROID_SDK_ROOT"))
	return excludeRoot(roots, androidsdk.Dir(s.toolsDir))
}

func excludeRoot(roots []string, exclude string) []string {
	var out []string
	for _, r := range roots {
		if r != exclude {
			out = append(out, r)
		}
	}
	return out
}

// UseExisting adopts an existing Android SDK found on the host in place of
// downloading AO's own managed copy. Re-detects fresh rather than trusting
// any client-supplied path -- the daemon only ever spawns binaries from a
// root it validated itself.
func (s *androidDeviceService) UseExisting(_ context.Context) error {
	d, ok := androidsdk.DetectExisting(s.candidateRoots(), s.plat.SysImgABI)
	if !ok {
		return fmt.Errorf("no existing Android SDK detected")
	}
	return s.manager.UseExternal(d)
}

func (s *androidDeviceService) DeviceStatus() controllers.AndroidEmulatorStatusResponse {
	st := s.emulatorManager.Status()
	return controllers.AndroidEmulatorStatusResponse{
		State:          string(st.State),
		Error:          st.Error,
		Logs:           st.Logs,
		AccelAvailable: st.AccelAvailable,
		AccelDetail:    st.AccelDetail,
	}
}

// StartDevice boots AO's single managed emulator: writes/refreshes the fixed
// AVD's config against whatever system image is currently installed,
// invalidates a stale quick-boot snapshot if the installed version changed
// since last boot, then hands off to emulatorManager for the actual
// spawn/health-check/crash-restart lifecycle.
// ensureAndroidPrefsRoot creates and returns the directory the emulator uses
// for ANDROID_PREFS_ROOT (its own preferences/feature-flags lock file). The
// emulator does not create this directory itself; without it, boot fails
// immediately with a flood of "Unexpected error while creating ...
// emu-last-feature-flags.protobuf.lock (error: 3)" and the ready-poll times
// out, surfacing as a generic "crashed" state.
func ensureAndroidPrefsRoot(toolsDir string) (string, error) {
	dir := filepath.Join(toolsDir, "android-prefs")
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return "", fmt.Errorf("create android-prefs dir: %w", err)
	}
	return dir, nil
}

// androidBootPlan is the fully-resolved set of paths/config StartDevice
// needs to write the AVD and spawn the emulator, computed from whichever SDK
// is currently installed (AO's own managed copy, or a user-adopted external
// one -- see androidsdk.InstalledSDK). AO's own AVD/snapshot/prefs data
// (avdHome, avdDir, prefsRoot in StartDevice) is always derived from
// s.toolsDir, never from plan.SDKRoot: AO never writes into a detected
// external SDK's directory.
type androidBootPlan struct {
	Profile         androidemulator.DeviceProfile
	SysImageRelPath string
	EmulatorPath    string
	AdbPath         string
	SDKRoot         string
	VersionKey      string
}

func buildAndroidBootPlan(sdk androidsdk.InstalledSDK) androidBootPlan {
	return androidBootPlan{
		Profile:         androidemulator.DefaultProfile(sdk.APILevel, sdk.Tag, sdk.ABI),
		SysImageRelPath: systemImageRelPath(sdk.APILevel, sdk.Tag, sdk.ABI),
		EmulatorPath:    filepath.Join(androidsdk.EmulatorDirIn(sdk.Root), androidemulator.EmulatorBinaryName()),
		AdbPath:         filepath.Join(androidsdk.PlatformToolsDirIn(sdk.Root), androidsdk.AdbBinaryName()),
		SDKRoot:         sdk.Root,
		VersionKey:      sdk.VersionKey,
	}
}

func (s *androidDeviceService) StartDevice(ctx context.Context) error {
	sdk, ok := androidsdk.Installed(s.toolsDir)
	if !ok {
		return fmt.Errorf("android SDK is not installed; run setup first")
	}
	plan := buildAndroidBootPlan(sdk)

	avdHome := androidsdk.AVDHomeDir(s.toolsDir)
	if err := androidemulator.WriteAVDConfig(avdHome, androidAVDName, plan.Profile, plan.SysImageRelPath); err != nil {
		return fmt.Errorf("write AVD config: %w", err)
	}

	avdDir := filepath.Join(avdHome, androidAVDName+".avd")
	if _, err := androidemulator.EnsureSnapshotValid(avdDir, androidemulator.SnapshotVersion{
		VersionKey:  plan.VersionKey,
		ProfileHash: fmt.Sprintf("%+v", plan.Profile),
	}); err != nil {
		return fmt.Errorf("check quick-boot snapshot validity: %w", err)
	}

	prefsRoot, err := ensureAndroidPrefsRoot(s.toolsDir)
	if err != nil {
		return err
	}

	env := []string{
		"ANDROID_AVD_HOME=" + avdHome,
		"ANDROID_SDK_ROOT=" + plan.SDKRoot,
		"ANDROID_PREFS_ROOT=" + prefsRoot,
	}

	return s.emulatorManager.Start(ctx, androidemulator.BootConfig{
		Command: plan.EmulatorPath,
		Args: []string{
			"-avd", androidAVDName,
			"-no-window", "-no-audio", "-no-boot-anim",
			"-grpc", fmt.Sprintf("%d", androidGRPCPort),
		},
		Env: env,
		AccelCheck: func(ctx context.Context) (androidemulator.AccelStatus, error) {
			return androidemulator.CheckAcceleration(ctx, plan.EmulatorPath)
		},
		ReadyCheck:        func(ctx context.Context) (bool, error) { return adbBootCompleted(ctx, plan.AdbPath) },
		ReadyPollInterval: androidReadyPollInterval,
		ReadyTimeout:      androidReadyTimeout,
		RestartBackoff:    androidRestartBackoff,
	})
}

func (s *androidDeviceService) StopDevice(ctx context.Context) error {
	return s.emulatorManager.Stop(ctx)
}

// Close stops the managed emulator and its gRPC connection as part of
// daemon graceful shutdown.
func (s *androidDeviceService) Close(ctx context.Context) {
	_ = s.emulatorManager.Stop(ctx)
	s.connMu.Lock()
	if s.emuClient != nil {
		_ = s.emuClient.Close()
		s.emuClient = nil
	}
	s.connMu.Unlock()
}

// ensureClient lazily dials the emulator's gRPC port on first use and wires
// up the frame relay/input proxy around it. Safe to call repeatedly; only
// the first call actually dials.
func (s *androidDeviceService) ensureClient() (*androidemulator.EmulatorClient, error) {
	s.connMu.Lock()
	defer s.connMu.Unlock()
	if s.emuClient != nil {
		return s.emuClient, nil
	}
	client, err := androidemulator.DialEmulator(fmt.Sprintf("127.0.0.1:%d", androidGRPCPort))
	if err != nil {
		return nil, err
	}
	s.emuClient = client
	s.frameRelay = androidemulator.NewFrameRelay(client.Screenshot, androidFramePollInterval)
	s.inputProxy = androidemulator.NewInputProxy(client)
	return client, nil
}

// SubscribeFrames returns a live PNG frame channel for the running device.
// Refuses (rather than subscribing to a relay with nothing to poll) unless
// the emulator is actually Running.
func (s *androidDeviceService) SubscribeFrames() (<-chan []byte, func(), error) {
	if st := s.emulatorManager.Status(); st.State != androidemulator.StateRunning {
		return nil, nil, fmt.Errorf("android device is not running (state: %s)", st.State)
	}
	if _, err := s.ensureClient(); err != nil {
		return nil, nil, fmt.Errorf("connect to emulator: %w", err)
	}
	frames, unsub := s.frameRelay.Subscribe()
	return frames, unsub, nil
}

// SendInput forwards one input action to the running device.
func (s *androidDeviceService) SendInput(ctx context.Context, action controllers.AndroidInputActionRequest) error {
	if st := s.emulatorManager.Status(); st.State != androidemulator.StateRunning {
		return fmt.Errorf("android device is not running (state: %s)", st.State)
	}
	if _, err := s.ensureClient(); err != nil {
		return fmt.Errorf("connect to emulator: %w", err)
	}
	return s.inputProxy.Handle(ctx, androidemulator.InputAction{
		Type: action.Type,
		X:    action.X, Y: action.Y,
		X2: action.X2, Y2: action.Y2,
		Key:  action.Key,
		Text: action.Text,
	})
}

// Screenshot captures a single on-demand PNG of the current screen.
func (s *androidDeviceService) Screenshot(ctx context.Context) ([]byte, error) {
	if st := s.emulatorManager.Status(); st.State != androidemulator.StateRunning {
		return nil, fmt.Errorf("android device is not running (state: %s)", st.State)
	}
	client, err := s.ensureClient()
	if err != nil {
		return nil, fmt.Errorf("connect to emulator: %w", err)
	}
	return client.Screenshot(ctx)
}

// InspectUI returns the current on-screen UI hierarchy via uiautomator.
func (s *androidDeviceService) InspectUI(ctx context.Context) (controllers.AndroidUINode, error) {
	if st := s.emulatorManager.Status(); st.State != androidemulator.StateRunning {
		return controllers.AndroidUINode{}, fmt.Errorf("android device is not running (state: %s)", st.State)
	}
	sdk, ok := androidsdk.Installed(s.toolsDir)
	if !ok {
		return controllers.AndroidUINode{}, fmt.Errorf("android SDK is not installed")
	}
	adbPath := filepath.Join(androidsdk.PlatformToolsDirIn(sdk.Root), androidsdk.AdbBinaryName())
	node, err := androidemulator.UIInspect(ctx, adbPath, androidDeviceSerial)
	if err != nil {
		return controllers.AndroidUINode{}, err
	}
	return convertUINode(node), nil
}

func convertUINode(n androidemulator.UINode) controllers.AndroidUINode {
	out := controllers.AndroidUINode{
		Class:       n.Class,
		ResourceID:  n.ResourceID,
		Text:        n.Text,
		ContentDesc: n.ContentDesc,
		Clickable:   n.Clickable,
		Bounds: controllers.AndroidUIBounds{
			X1: n.Bounds.X1, Y1: n.Bounds.Y1,
			X2: n.Bounds.X2, Y2: n.Bounds.Y2,
		},
	}
	for _, c := range n.Children {
		out.Children = append(out.Children, convertUINode(c))
	}
	return out
}

func systemImageRelPath(apiLevel int, tag, abi string) string {
	return fmt.Sprintf("system-images/android-%d/%s/%s/", apiLevel, tag, abi)
}

// adbBootCompleted polls whether AO's managed device has finished booting,
// via the same real mechanism (adb getprop sys.boot_completed) verified
// during the A0 spike.
func adbBootCompleted(ctx context.Context, adbPath string) (bool, error) {
	cmd := exec.CommandContext(ctx, adbPath, "-s", androidDeviceSerial, "shell", "getprop", "sys.boot_completed")
	out, err := cmd.Output()
	if err != nil {
		return false, nil //nolint:nilerr // device likely not connected yet; not a hard error
	}
	return strings.TrimSpace(string(out)) == "1", nil
}
