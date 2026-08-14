package daemon

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/androidemulator"
	"github.com/aoagents/agent-orchestrator/backend/internal/androidsdk"
)

// writeFakeSDKFixture creates a minimal, on-disk fake SDK (adb + emulator
// "binaries" that are real files but not actually runnable, plus one system
// image) under root, matching the standard SDK repository layout.
func writeFakeSDKFixture(t *testing.T, root string, apiLevel int, tag, abi string) {
	t.Helper()
	mustWriteTestFile(t, filepath.Join(root, "platform-tools", androidsdk.AdbBinaryName()), "adb")
	mustWriteTestFile(t, filepath.Join(root, "emulator", androidemulator.EmulatorBinaryName()), "emulator")
	imgDir := filepath.Join(root, "system-images", fmt.Sprintf("android-%d", apiLevel), tag, abi)
	mustWriteTestFile(t, filepath.Join(imgDir, "system.img"), "system image bytes")
}

func mustWriteTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

// newTestAndroidDeviceService builds a service directly (bypassing
// newAndroidDeviceService's real HostPlatform() detection) so tests are
// deterministic regardless of the machine running them.
func newTestAndroidDeviceService(toolsDir string) *androidDeviceService {
	return &androidDeviceService{
		manager:         androidsdk.NewManager(toolsDir),
		client:          &http.Client{},
		plat:            androidsdk.Platform{RepoOS: "windows", RepoArch: "x64", SysImgABI: "x86_64"},
		toolsDir:        toolsDir,
		emulatorManager: androidemulator.NewManager(),
	}
}

// isolateCandidateRootEnv neutralizes every env-derived default candidate
// root so detection tests only ever see what the test explicitly sets up --
// otherwise a developer's real machine (e.g. a genuine Android Studio
// install) could make these tests flaky.
func isolateCandidateRootEnv(t *testing.T) {
	t.Helper()
	empty := t.TempDir()
	t.Setenv("ANDROID_HOME", "")
	t.Setenv("ANDROID_SDK_ROOT", "")
	t.Setenv("LOCALAPPDATA", empty)
	t.Setenv("HOME", empty)
}

// TestEnsureAndroidPrefsRootCreatesDirectory covers a real boot failure: the
// Android emulator does not create its own ANDROID_PREFS_ROOT directory. When
// it's missing, the emulator fails immediately with a flood of "Unexpected
// error while creating ... emu-last-feature-flags.protobuf.lock (error: 3)"
// and never reaches the gRPC-ready state, timing out as "crashed".
func TestEnsureAndroidPrefsRootCreatesDirectory(t *testing.T) {
	toolsDir := t.TempDir()
	wantDir := filepath.Join(toolsDir, "android-prefs")

	if _, err := os.Stat(wantDir); !os.IsNotExist(err) {
		t.Fatalf("precondition: %s should not exist yet", wantDir)
	}

	got, err := ensureAndroidPrefsRoot(toolsDir)
	if err != nil {
		t.Fatalf("ensureAndroidPrefsRoot: %v", err)
	}
	if got != wantDir {
		t.Errorf("dir = %q, want %q", got, wantDir)
	}
	if info, err := os.Stat(wantDir); err != nil || !info.IsDir() {
		t.Errorf("expected %s to exist as a directory after ensureAndroidPrefsRoot, stat err = %v", wantDir, err)
	}
}

func TestEnsureAndroidPrefsRootIdempotent(t *testing.T) {
	toolsDir := t.TempDir()

	if _, err := ensureAndroidPrefsRoot(toolsDir); err != nil {
		t.Fatalf("first call: %v", err)
	}
	if _, err := ensureAndroidPrefsRoot(toolsDir); err != nil {
		t.Fatalf("second call on an already-existing dir: %v", err)
	}
}

func TestCandidateRootsExcludesOwnManagedDir(t *testing.T) {
	isolateCandidateRootEnv(t)
	toolsDir := t.TempDir()
	t.Setenv("ANDROID_HOME", androidsdk.Dir(toolsDir))

	svc := newTestAndroidDeviceService(toolsDir)
	for _, root := range svc.candidateRoots() {
		if root == androidsdk.Dir(toolsDir) {
			t.Fatalf("candidateRoots() = %v, must never include AO's own managed dir %q", svc.candidateRoots(), androidsdk.Dir(toolsDir))
		}
	}
}

func TestStatusPopulatesDetectedWhenNotInstalled(t *testing.T) {
	isolateCandidateRootEnv(t)
	toolsDir := t.TempDir()
	extRoot := t.TempDir()
	writeFakeSDKFixture(t, extRoot, 34, "google_apis", "x86_64")
	t.Setenv("ANDROID_HOME", extRoot)

	svc := newTestAndroidDeviceService(toolsDir)
	resp := svc.Status()

	if resp.State != string(androidsdk.StateNotInstalled) {
		t.Fatalf("State = %q, want %q", resp.State, androidsdk.StateNotInstalled)
	}
	if resp.Detected == nil {
		t.Fatal("Detected is nil, want a populated detection result")
	}
	if resp.Detected.Root != extRoot || resp.Detected.APILevel != 34 || resp.Detected.Tag != "google_apis" || resp.Detected.ABI != "x86_64" {
		t.Errorf("Detected = %+v, want Root=%q APILevel=34 Tag=google_apis ABI=x86_64", resp.Detected, extRoot)
	}
}

func TestStatusPopulatesDetectedWhenFailed(t *testing.T) {
	isolateCandidateRootEnv(t)
	toolsDir := t.TempDir()
	extRoot := t.TempDir()
	writeFakeSDKFixture(t, extRoot, 34, "google_apis", "x86_64")
	t.Setenv("ANDROID_HOME", extRoot)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	svc := newTestAndroidDeviceService(toolsDir)
	if err := svc.manager.StartInstall(androidsdk.InstallConfig{
		Client: srv.Client(), RepositoryManifestURL: srv.URL + "/a", SysImgManifestURL: srv.URL + "/b",
		DownloadBaseURL: srv.URL + "/", SysImgDownloadBaseURL: srv.URL + "/", ToolsDir: toolsDir,
		Platform: svc.plat, APILevel: 34, Tag: "google_apis", AcceptLicenses: true,
	}); err != nil {
		t.Fatalf("StartInstall: %v", err)
	}
	waitForManagerState(t, svc.manager, androidsdk.StateFailed)

	resp := svc.Status()
	if resp.State != string(androidsdk.StateFailed) {
		t.Fatalf("State = %q, want %q", resp.State, androidsdk.StateFailed)
	}
	if resp.Detected == nil {
		t.Fatal("Detected is nil, want a populated detection result even in the failed state")
	}
}

func waitForManagerState(t *testing.T, m *androidsdk.Manager, want androidsdk.State) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if m.Status().State == want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("Manager never reached state %q, stuck at %q", want, m.Status().State)
}

func TestStatusPopulatesSourceWhenAOManaged(t *testing.T) {
	toolsDir := t.TempDir()
	writeAOManagedManifestForTest(t, toolsDir)
	svc := newTestAndroidDeviceService(toolsDir)

	resp := svc.Status()
	if resp.State != string(androidsdk.StateInstalled) {
		t.Fatalf("State = %q, want %q", resp.State, androidsdk.StateInstalled)
	}
	if resp.Source != androidsdk.SourceAOManaged {
		t.Errorf("Source = %q, want %q", resp.Source, androidsdk.SourceAOManaged)
	}
}

func TestStatusPopulatesSourceWhenExternal(t *testing.T) {
	toolsDir := t.TempDir()
	extRoot := t.TempDir()
	writeFakeSDKFixture(t, extRoot, 34, "google_apis", "x86_64")
	svc := newTestAndroidDeviceService(toolsDir)
	d := androidsdk.DetectedSDK{Root: extRoot, SystemImage: androidsdk.DetectedSystemImage{APILevel: 34, Tag: "google_apis", ABI: "x86_64"}}
	if err := svc.manager.UseExternal(d); err != nil {
		t.Fatal(err)
	}

	resp := svc.Status()
	if resp.Source != androidsdk.SourceExternal {
		t.Errorf("Source = %q, want %q", resp.Source, androidsdk.SourceExternal)
	}
}

func TestUseExistingAdoptsDetectedSDK(t *testing.T) {
	isolateCandidateRootEnv(t)
	toolsDir := t.TempDir()
	extRoot := t.TempDir()
	writeFakeSDKFixture(t, extRoot, 34, "google_apis", "x86_64")
	t.Setenv("ANDROID_HOME", extRoot)

	svc := newTestAndroidDeviceService(toolsDir)
	if err := svc.UseExisting(context.Background()); err != nil {
		t.Fatalf("UseExisting: %v", err)
	}

	sdk, ok := androidsdk.Installed(toolsDir)
	if !ok || sdk.Source != androidsdk.SourceExternal || sdk.Root != extRoot {
		t.Errorf("Installed = %+v (ok=%v), want Source=%q Root=%q", sdk, ok, androidsdk.SourceExternal, extRoot)
	}
}

func TestUseExistingErrorsWhenNothingDetected(t *testing.T) {
	isolateCandidateRootEnv(t)
	svc := newTestAndroidDeviceService(t.TempDir())
	if err := svc.UseExisting(context.Background()); err == nil {
		t.Error("UseExisting: want an error when nothing is detected, got nil")
	}
}

func TestBuildAndroidBootPlanUsesInstalledSDKFields(t *testing.T) {
	sdk := androidsdk.InstalledSDK{
		Source: androidsdk.SourceExternal, Root: filepath.Join("C:", "external", "sdk"),
		APILevel: 30, Tag: "default", ABI: "arm64-v8a", VersionKey: "vkey",
	}
	plan := buildAndroidBootPlan(sdk)

	wantEmulator := filepath.Join(sdk.Root, "emulator", androidemulator.EmulatorBinaryName())
	wantAdb := filepath.Join(sdk.Root, "platform-tools", androidsdk.AdbBinaryName())
	if plan.EmulatorPath != wantEmulator {
		t.Errorf("EmulatorPath = %q, want %q", plan.EmulatorPath, wantEmulator)
	}
	if plan.AdbPath != wantAdb {
		t.Errorf("AdbPath = %q, want %q", plan.AdbPath, wantAdb)
	}
	if plan.SDKRoot != sdk.Root {
		t.Errorf("SDKRoot = %q, want %q", plan.SDKRoot, sdk.Root)
	}
	if plan.VersionKey != "vkey" {
		t.Errorf("VersionKey = %q, want %q", plan.VersionKey, "vkey")
	}
	if plan.Profile.APILevel != 30 || plan.Profile.Tag != "default" || plan.Profile.ABI != "arm64-v8a" {
		t.Errorf("Profile = %+v, want APILevel=30 Tag=default ABI=arm64-v8a", plan.Profile)
	}
	wantRelPath := "system-images/android-30/default/arm64-v8a/"
	if plan.SysImageRelPath != wantRelPath {
		t.Errorf("SysImageRelPath = %q, want %q", plan.SysImageRelPath, wantRelPath)
	}
}

func TestStartDeviceUsesExternalSDKAndNeverWritesUnderItsRoot(t *testing.T) {
	toolsDir := t.TempDir()
	extRoot := t.TempDir()
	writeFakeSDKFixture(t, extRoot, 34, "google_apis", "x86_64")
	filesBefore := listFilesRecursive(t, extRoot)

	svc := newTestAndroidDeviceService(toolsDir)
	d := androidsdk.DetectedSDK{Root: extRoot, SystemImage: androidsdk.DetectedSystemImage{APILevel: 34, Tag: "google_apis", ABI: "x86_64"}}
	if err := svc.manager.UseExternal(d); err != nil {
		t.Fatal(err)
	}

	// The fixture "emulator"/"adb" files aren't real executables, so Start
	// is expected to fail once it actually tries to spawn -- this test only
	// cares that everything BEFORE that spawn attempt (AVD config, snapshot
	// marker, prefs dir) was computed from the external SDK correctly, and
	// that nothing was ever written back into the external root.
	_ = svc.StartDevice(context.Background())

	configPath := filepath.Join(androidsdk.AVDHomeDir(toolsDir), androidAVDName+".avd", "config.ini")
	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("reading AVD config: %v", err)
	}
	wantLine := "image.sysdir.1=system-images/android-34/google_apis/x86_64/"
	if !strings.Contains(string(data), wantLine) {
		t.Errorf("AVD config.ini does not contain %q:\n%s", wantLine, data)
	}

	filesAfter := listFilesRecursive(t, extRoot)
	if len(filesAfter) != len(filesBefore) {
		t.Errorf("files under the external root changed (before=%v after=%v); StartDevice must never write there", filesBefore, filesAfter)
	}
}

func listFilesRecursive(t *testing.T, root string) []string {
	t.Helper()
	var out []string
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() {
			rel, _ := filepath.Rel(root, path)
			out = append(out, rel)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// writeAOManagedManifestForTest writes AO's managed-install idempotency
// manifest directly (its on-disk JSON shape is androidsdk's implementation
// detail, but the file format itself -- what readInstalledManifest parses --
// is the stable contract these fields rely on).
func writeAOManagedManifestForTest(t *testing.T, toolsDir string) {
	t.Helper()
	data := []byte(`{"platformToolsSha1":"pt","emulatorSha1":"em","systemImageSha1":"sha1","apiLevel":34,"tag":"google_apis","abi":"x86_64"}`)
	if err := os.MkdirAll(androidsdk.Dir(toolsDir), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(androidsdk.ManifestPath(toolsDir), data, 0o600); err != nil {
		t.Fatal(err)
	}
}
