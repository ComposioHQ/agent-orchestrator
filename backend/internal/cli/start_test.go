package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

// writeMarker writes a ~/.ao/app-state.json marker pointing at appPath into the
// configured state dir (AO_RUN_FILE's directory).
func writeMarker(t *testing.T, cfg testConfig, appPath string) {
	t.Helper()
	st := appState{SchemaVersion: 1, AppPath: appPath, InstallSource: "npm-bootstrap"}
	data, err := json.Marshal(st)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Dir(cfg.runFile)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, appStateFileName), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

// makeBundle creates a path that stats as a usable bundle on the host OS:
// a directory on macOS (.app), a regular file on Windows/Linux (exe/AppImage),
// matching isUsableBundle's per-OS rule.
func makeBundle(t *testing.T, name string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if runtime.GOOS == "darwin" {
		if err := os.MkdirAll(p, 0o750); err != nil {
			t.Fatal(err)
		}
		return p
	}
	if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestResolveApp_MarkerHit(t *testing.T) {
	cfg := setConfigEnv(t)
	bundle := makeBundle(t, appBundleName)
	writeMarker(t, cfg, bundle)
	// No scan locations: a hit must come from the marker.
	t.Cleanup(swapScanLocations(func() []string { return nil }))
	// Point the preferred location at nothing so this exercises the marker,
	// not the real /Applications on a macOS dev box.
	t.Cleanup(swapPreferredAppPath(func() string { return "" }))

	c := &commandContext{deps: Deps{}.withDefaults()}
	got := c.resolveApp()
	if got != bundle {
		t.Fatalf("resolveApp = %q, want marker path %q", got, bundle)
	}
}

// The downgrade the marker used to re-propagate: a stale copy that got
// launched leaves the marker pointing at itself, and `ao start` would reopen
// that copy forever instead of the install the updater maintains.
func TestResolveApp_PreferredOutranksMarker(t *testing.T) {
	cfg := setConfigEnv(t)
	stale := makeBundle(t, appBundleName)
	writeMarker(t, cfg, stale)
	installed := makeBundle(t, appBundleName)
	t.Cleanup(swapPreferredAppPath(func() string { return installed }))
	t.Cleanup(swapScanLocations(func() []string { return nil }))

	c := &commandContext{deps: Deps{}.withDefaults()}
	got := c.resolveApp()
	if got != installed {
		t.Fatalf("resolveApp = %q, want installed path %q", got, installed)
	}
}

// An absent preferred location must not shadow a good marker.
func TestResolveApp_PreferredMissingFallsBackToMarker(t *testing.T) {
	cfg := setConfigEnv(t)
	bundle := makeBundle(t, appBundleName)
	writeMarker(t, cfg, bundle)
	t.Cleanup(swapPreferredAppPath(func() string {
		return filepath.Join(t.TempDir(), "gone", appBundleName)
	}))
	t.Cleanup(swapScanLocations(func() []string { return nil }))

	c := &commandContext{deps: Deps{}.withDefaults()}
	got := c.resolveApp()
	if got != bundle {
		t.Fatalf("resolveApp = %q, want marker path %q", got, bundle)
	}
}

func TestResolveApp_MarkerMissThenScanHit(t *testing.T) {
	cfg := setConfigEnv(t)
	// Marker points at a path that does not exist -> must fall through to scan.
	writeMarker(t, cfg, filepath.Join(t.TempDir(), "gone", appBundleName))
	scanBundle := makeBundle(t, appBundleName)
	t.Cleanup(swapScanLocations(func() []string { return []string{scanBundle} }))
	t.Cleanup(swapPreferredAppPath(func() string { return "" }))

	c := &commandContext{deps: Deps{}.withDefaults()}
	got := c.resolveApp()
	if got != scanBundle {
		t.Fatalf("resolveApp = %q, want scan path %q", got, scanBundle)
	}
}

func TestResolveApp_ScanMissReturnsEmpty(t *testing.T) {
	setConfigEnv(t) // no marker written
	t.Cleanup(swapScanLocations(func() []string {
		return []string{filepath.Join(t.TempDir(), "nope", appBundleName)}
	}))
	t.Cleanup(swapPreferredAppPath(func() string { return "" }))

	c := &commandContext{deps: Deps{}.withDefaults()}
	got := c.resolveApp()
	if got != "" {
		t.Fatalf("resolveApp = %q, want empty", got)
	}
}

func TestAssetArchMapping(t *testing.T) {
	cases := map[string]struct {
		want    string
		wantErr bool
	}{
		"arm64": {want: "arm64"},
		"amd64": {want: "x64"},
		"386":   {wantErr: true},
	}
	for goarch, tc := range cases {
		got, err := assetArch(goarch)
		if tc.wantErr {
			if err == nil {
				t.Errorf("assetArch(%q) = %q, want error", goarch, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("assetArch(%q): unexpected error %v", goarch, err)
		}
		if got != tc.want {
			t.Errorf("assetArch(%q) = %q, want %q", goarch, got, tc.want)
		}
	}
}

func TestAssetName_PerOS(t *testing.T) {
	got, err := assetName()
	if err != nil {
		// On unsupported arch (e.g. arm64 win/linux) an error is expected; the
		// per-OS expectation below only applies on amd64/arm64 darwin.
		if runtime.GOOS == "windows" || runtime.GOOS == "linux" {
			if runtime.GOARCH != "amd64" {
				return // unsupported-arch error is correct
			}
		}
		t.Fatalf("assetName() unexpected error: %v", err)
	}
	switch runtime.GOOS {
	case "darwin":
		if got != "agent-orchestrator-darwin-arm64.zip" && got != "agent-orchestrator-darwin-x64.zip" {
			t.Fatalf("darwin assetName = %q", got)
		}
	case "windows":
		if got != "agent-orchestrator-win32-x64.exe" {
			t.Fatalf("windows assetName = %q, want agent-orchestrator-win32-x64.exe", got)
		}
	case "linux":
		if got != "agent-orchestrator-linux-x64.AppImage" {
			t.Fatalf("linux assetName = %q, want agent-orchestrator-linux-x64.AppImage", got)
		}
	}
}

func TestRequireAMD64(t *testing.T) {
	// Host-independent: requireAMD64 keys off runtime.GOARCH, which is amd64 or
	// arm64 on every CI/dev host. Either branch is a valid assertion.
	got, err := requireAMD64()
	if runtime.GOARCH == "amd64" {
		if err != nil || got != "x64" {
			t.Fatalf("requireAMD64() on amd64 = (%q, %v), want (x64, nil)", got, err)
		}
	} else if err == nil {
		t.Fatalf("requireAMD64() on %s = nil error, want unsupported-arch error", runtime.GOARCH)
	}
}

func TestWindowsInstalledExe(t *testing.T) {
	got := windowsInstalledExe("C:\\Users\\me\\AppData\\Local")
	want := filepath.Join("C:\\Users\\me\\AppData\\Local", "Programs", "Agent Orchestrator", "agent-orchestrator.exe")
	if got != want {
		t.Fatalf("windowsInstalledExe = %q, want %q", got, want)
	}
}

func TestKnownAppLocations_HostOS(t *testing.T) {
	// knownAppLocations must return at least one candidate on every supported OS
	// (given the relevant env). Windows needs LOCALAPPDATA; set it so the test is
	// deterministic regardless of host.
	if runtime.GOOS == "windows" {
		t.Setenv("LOCALAPPDATA", "C:\\Users\\me\\AppData\\Local")
	}
	switch runtime.GOOS {
	case "darwin", "windows", "linux":
		if len(knownAppLocations()) == 0 {
			t.Fatalf("knownAppLocations() empty on %s", runtime.GOOS)
		}
	}
}

// A deb, rpm or pacman install must be resolvable, or `ao start` downloads an
// AppImage onto a machine that already has AO installed. It is scanned last:
// when both exist, the AppImage under ~/.ao is the copy that self-updates.
func TestKnownAppLocations_LinuxIncludesPackagedInstallLast(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux-only scan order")
	}
	paths := knownAppLocations()
	if got := paths[len(paths)-1]; got != linuxSystemAppPath {
		t.Fatalf("last scan location = %q, want %q", got, linuxSystemAppPath)
	}
	for _, p := range paths[:len(paths)-1] {
		if p == linuxSystemAppPath {
			t.Fatalf("packaged install scanned before the AppImage: %#v", paths)
		}
	}
}

func TestIsUsableBundle_RegularFileVsDir(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "agent-orchestrator.AppImage")
	if err := os.WriteFile(file, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	subdir := filepath.Join(dir, "Agent Orchestrator.app")
	if err := os.MkdirAll(subdir, 0o750); err != nil {
		t.Fatal(err)
	}
	switch runtime.GOOS {
	case "darwin":
		if !isUsableBundle(subdir) {
			t.Fatal("darwin: dir bundle should be usable")
		}
		if isUsableBundle(file) {
			t.Fatal("darwin: regular file should not be a usable bundle")
		}
	case "windows", "linux":
		if !isUsableBundle(file) {
			t.Fatal("win/linux: regular file should be usable")
		}
		if isUsableBundle(subdir) {
			t.Fatal("win/linux: directory should not be a usable bundle")
		}
	}
	if isUsableBundle(filepath.Join(dir, "missing")) {
		t.Fatal("missing path should not be usable")
	}
}

func TestDownloadURLUsesReleaseRepo(t *testing.T) {
	orig := releaseRepo
	releaseRepo = "owner/repo"
	t.Cleanup(func() { releaseRepo = orig })

	got := downloadURL("agent-orchestrator-darwin-arm64.zip")
	want := "https://github.com/owner/repo/releases/latest/download/agent-orchestrator-darwin-arm64.zip"
	if got != want {
		t.Fatalf("downloadURL = %q, want %q", got, want)
	}
}

func TestInstallLinuxDesktopEntry(t *testing.T) {
	dataHome := t.TempDir()
	t.Setenv("XDG_DATA_HOME", dataHome)
	// The AppImage lives beside the scratch directory the icon is extracted
	// into, so it needs a real directory rather than a literal path.
	appDir := t.TempDir()
	appPath := filepath.Join(appDir, "Agent Orchestrator 100%.AppImage")
	iconBytes := []byte("PNG-BYTES")

	var commands [][]string
	var extractions [][]string
	c := &commandContext{deps: Deps{
		CommandOutput: func(_ context.Context, name string, args ...string) ([]byte, error) {
			commands = append(commands, append([]string{name}, args...))
			if len(args) > 0 && args[0] == "query" {
				return []byte(linuxDesktopEntryName + "\n"), nil
			}
			return nil, nil
		},
		// Stands in for the AppImage runtime: it unpacks the requested file into
		// ./squashfs-root, relative to the directory it was told to run in.
		CommandOutputInDir: func(_ context.Context, dir, name string, args ...string) ([]byte, error) {
			extractions = append(extractions, append([]string{dir, name}, args...))
			extracted := filepath.Join(dir, "squashfs-root", linuxAppImageIconPath)
			if err := os.MkdirAll(filepath.Dir(extracted), 0o750); err != nil {
				return nil, err
			}
			return nil, os.WriteFile(extracted, iconBytes, 0o600)
		},
	}.withDefaults()}

	var stderr bytes.Buffer
	if err := c.installLinuxDesktopEntry(context.Background(), &stderr, appPath); err != nil {
		t.Fatal(err)
	}
	entryPath := filepath.Join(dataHome, "applications", linuxDesktopEntryName)
	entry, err := os.ReadFile(entryPath)
	if err != nil {
		t.Fatal(err)
	}
	content := string(entry)
	// The path holds a space and a %, both of which break a naive Exec line.
	wantExec := `Exec="` + strings.ReplaceAll(appPath, "%", "%%") + `" %u`
	if !strings.Contains(content, wantExec) {
		t.Fatalf("desktop entry does not safely target AppImage:\n%s", content)
	}
	if !strings.Contains(content, "MimeType=x-scheme-handler/ao-app;") {
		t.Fatalf("desktop entry does not register ao-app:\n%s", content)
	}
	// The point of the change: an entry carrying NoDisplay is hidden from the
	// applications menu, which is how AppImage users ended up hand-writing
	// launchers pointing at ~/Downloads.
	if strings.Contains(content, "NoDisplay") {
		t.Fatalf("desktop entry is still hidden from the menu:\n%s", content)
	}
	for _, want := range []string{
		"Icon=" + linuxIconName + "\n",
		"Categories=Development;\n",
		"Comment=",
		"Terminal=false\n",
	} {
		if !strings.Contains(content, want) {
			t.Fatalf("desktop entry is missing %q:\n%s", want, content)
		}
	}

	// Icon= names an icon, so one has to exist in the theme for the menu entry
	// to show anything but a generic placeholder.
	iconPath := filepath.Join(dataHome, linuxIconThemeDir, linuxIconName+".png")
	installed, err := os.ReadFile(iconPath)
	if err != nil {
		t.Fatalf("icon not installed into the theme: %v", err)
	}
	if !bytes.Equal(installed, iconBytes) {
		t.Fatalf("icon = %q, want %q", installed, iconBytes)
	}
	if len(extractions) != 1 {
		t.Fatalf("extractions = %#v, want exactly one", extractions)
	}
	if got := extractions[0][1:]; !reflect.DeepEqual(
		got,
		[]string{appPath, "--appimage-extract", linuxAppImageIconPath},
	) {
		t.Fatalf("extraction command = %#v", got)
	}
	// Extraction must not litter ~/.ao: the scratch directory is removed even
	// though squashfs-root is left inside it.
	leftovers, err := os.ReadDir(appDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(leftovers) != 0 {
		t.Fatalf("scratch directories left behind: %#v", leftovers)
	}

	wantCommands := [][]string{
		{"update-desktop-database", filepath.Join(dataHome, "applications")},
		{"xdg-mime", "default", linuxDesktopEntryName, "x-scheme-handler/ao-app"},
		{"xdg-mime", "query", "default", "x-scheme-handler/ao-app"},
	}
	if !reflect.DeepEqual(commands, wantCommands) {
		t.Fatalf("commands = %#v, want %#v", commands, wantCommands)
	}
}

// B4's decision, in code: when a distro package owns this install, its entry is
// the one in the menu and the one ao-app:// resolves to. `ao start` writes none
// of its own, and never touches the packaged file.
func TestInstallLinuxDesktopEntry_PackagedInstallOwnsTheMenu(t *testing.T) {
	dataHome := t.TempDir()
	t.Setenv("XDG_DATA_HOME", dataHome)

	systemEntry := filepath.Join(t.TempDir(), linuxSystemDesktopEntryName)
	if err := os.WriteFile(systemEntry, []byte("[Desktop Entry]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	original := linuxSystemDesktopEntryPath
	linuxSystemDesktopEntryPath = systemEntry
	t.Cleanup(func() { linuxSystemDesktopEntryPath = original })

	// An entry from an earlier AppImage launch, pointing at an AppImage this
	// machine no longer runs.
	userEntry := filepath.Join(dataHome, "applications", linuxDesktopEntryName)
	if err := os.MkdirAll(filepath.Dir(userEntry), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(userEntry, []byte("[Desktop Entry]\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	var commands [][]string
	c := &commandContext{deps: Deps{
		CommandOutput: func(_ context.Context, name string, args ...string) ([]byte, error) {
			commands = append(commands, append([]string{name}, args...))
			if len(args) > 0 && args[0] == "query" {
				return []byte(linuxSystemDesktopEntryName + "\n"), nil
			}
			return nil, nil
		},
		CommandOutputInDir: func(_ context.Context, _, _ string, _ ...string) ([]byte, error) {
			t.Fatal("packaged install must not extract an icon from an AppImage")
			return nil, nil
		},
	}.withDefaults()}

	var stderr bytes.Buffer
	if err := c.installLinuxDesktopEntry(context.Background(), &stderr, linuxSystemAppPath); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(userEntry); !os.IsNotExist(err) {
		t.Fatalf("stale AppImage entry still present: %v", err)
	}
	if _, err := os.Stat(systemEntry); err != nil {
		t.Fatalf("packaged entry was disturbed: %v", err)
	}
	wantCommands := [][]string{
		{"update-desktop-database", filepath.Join(dataHome, "applications")},
		{"xdg-mime", "default", linuxSystemDesktopEntryName, "x-scheme-handler/ao-app"},
		{"xdg-mime", "query", "default", "x-scheme-handler/ao-app"},
	}
	if !reflect.DeepEqual(commands, wantCommands) {
		t.Fatalf("commands = %#v, want %#v", commands, wantCommands)
	}
}

// The same appPath without the package's entry on disk is not a packaged
// install (a bare /usr/bin symlink someone made by hand, say), so the normal
// path still applies.
func TestInstallLinuxDesktopEntry_NoSystemEntryMeansNoHandoff(t *testing.T) {
	dataHome := t.TempDir()
	t.Setenv("XDG_DATA_HOME", dataHome)
	original := linuxSystemDesktopEntryPath
	linuxSystemDesktopEntryPath = filepath.Join(t.TempDir(), "absent.desktop")
	t.Cleanup(func() { linuxSystemDesktopEntryPath = original })

	c := &commandContext{deps: Deps{
		CommandOutput: func(_ context.Context, _ string, args ...string) ([]byte, error) {
			if len(args) > 0 && args[0] == "query" {
				return []byte(linuxDesktopEntryName + "\n"), nil
			}
			return nil, nil
		},
		CommandOutputInDir: func(_ context.Context, _, _ string, _ ...string) ([]byte, error) {
			return []byte("no such file"), errors.New("exec: --appimage-extract")
		},
	}.withDefaults()}

	var stderr bytes.Buffer
	if err := c.installLinuxDesktopEntry(context.Background(), &stderr, linuxSystemAppPath); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dataHome, "applications", linuxDesktopEntryName)); err != nil {
		t.Fatalf("desktop entry not written: %v", err)
	}
}

// A missing icon, or a machine without desktop-file-utils, degrades the menu
// entry. It must never stop the app from starting.
func TestInstallLinuxDesktopEntry_BestEffortStepsDoNotBlockLaunch(t *testing.T) {
	dataHome := t.TempDir()
	t.Setenv("XDG_DATA_HOME", dataHome)
	appPath := filepath.Join(t.TempDir(), "agent-orchestrator.AppImage")

	c := &commandContext{deps: Deps{
		CommandOutput: func(_ context.Context, name string, args ...string) ([]byte, error) {
			if name == "update-desktop-database" {
				return []byte("not found"), errors.New("exec: update-desktop-database")
			}
			if len(args) > 0 && args[0] == "query" {
				return []byte(linuxDesktopEntryName + "\n"), nil
			}
			return nil, nil
		},
		CommandOutputInDir: func(_ context.Context, _, _ string, _ ...string) ([]byte, error) {
			return []byte("no such file"), errors.New("exec: --appimage-extract")
		},
	}.withDefaults()}

	var stderr bytes.Buffer
	if err := c.installLinuxDesktopEntry(context.Background(), &stderr, appPath); err != nil {
		t.Fatalf("launch blocked by a best-effort step: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dataHome, "applications", linuxDesktopEntryName)); err != nil {
		t.Fatalf("desktop entry not written: %v", err)
	}
	for _, want := range []string{"menu icon", "applications menu"} {
		if !strings.Contains(stderr.String(), want) {
			t.Fatalf("stderr does not mention %q:\n%s", want, stderr.String())
		}
	}
}

func TestOpenApp_ArgConstruction(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("openApp launches via `open` only on darwin")
	}
	var gotName string
	var gotArgs []string
	c := &commandContext{deps: Deps{
		CommandOutput: func(_ context.Context, name string, args ...string) ([]byte, error) {
			gotName = name
			gotArgs = args
			return nil, nil
		},
	}.withDefaults()}

	opened, err := c.openApp(context.Background(), "/Applications/Agent Orchestrator.app")
	if err != nil {
		t.Fatal(err)
	}
	if !opened {
		t.Fatal("openApp reported not opened")
	}
	if gotName != "open" {
		t.Fatalf("command = %q, want open", gotName)
	}
	wantArgs := []string{"/Applications/Agent Orchestrator.app", "--args", "--installed-via=npm-bootstrap"}
	if !reflect.DeepEqual(gotArgs, wantArgs) {
		t.Fatalf("args = %v, want %v", gotArgs, wantArgs)
	}
}

func TestOpenApp_DetachedSpawnOnWinLinux(t *testing.T) {
	if runtime.GOOS != "windows" && runtime.GOOS != "linux" {
		t.Skip("openApp spawns detached only on windows/linux")
	}
	var gotCfg processStartConfig
	c := &commandContext{deps: Deps{
		StartProcess: func(cfg processStartConfig) error {
			gotCfg = cfg
			return nil
		},
	}.withDefaults()}

	appPath := "/some/agent-orchestrator.AppImage"
	opened, err := c.openApp(context.Background(), appPath)
	if err != nil {
		t.Fatal(err)
	}
	if !opened {
		t.Fatal("openApp reported not opened")
	}
	if gotCfg.Path != appPath {
		t.Fatalf("spawn path = %q, want %q", gotCfg.Path, appPath)
	}
	wantArgs := []string{"--installed-via=npm-bootstrap"}
	if !reflect.DeepEqual(gotCfg.Args, wantArgs) {
		t.Fatalf("spawn args = %v, want %v", gotCfg.Args, wantArgs)
	}
}

func TestOpenApp_SpawnFailureFallsBackToManual(t *testing.T) {
	if runtime.GOOS != "windows" && runtime.GOOS != "linux" {
		t.Skip("detached-spawn fallback only on windows/linux")
	}
	c := &commandContext{deps: Deps{
		StartProcess: func(processStartConfig) error { return os.ErrNotExist },
	}.withDefaults()}

	opened, err := c.openApp(context.Background(), "/some/app")
	if err != nil {
		t.Fatalf("openApp should swallow spawn errors, got %v", err)
	}
	if opened {
		t.Fatal("openApp should report not-opened on spawn failure")
	}
}

// TestDownload_IgnoresShortClientTimeout proves download() does not inherit the
// 2s deps.HTTPClient timeout (sized for loopback probes), which would otherwise
// fail every real release download. The server responds after a delay that
// exceeds the injected client's tiny timeout; download must still succeed.
func TestDownload_IgnoresShortClientTimeout(t *testing.T) {
	const body = "release-zip-bytes"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(150 * time.Millisecond)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)

	c := &commandContext{deps: Deps{
		// 50ms timeout: if download honored this, the 150ms server would fail it.
		HTTPClient: &http.Client{Timeout: 50 * time.Millisecond},
	}.withDefaults()}

	dst := filepath.Join(t.TempDir(), "out.zip")
	if err := c.download(context.Background(), io.Discard, srv.URL, "out.zip", dst); err != nil {
		t.Fatalf("download failed (short client timeout leaked into large-asset path?): %v", err)
	}
	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != body {
		t.Fatalf("downloaded %q, want %q", got, body)
	}
}

// TestDownload_NonTTYProgress proves a non-interactive writer (a bytes.Buffer is
// not an *os.File, so it's non-TTY) gets a plain start line plus a final done
// line and NO carriage returns, while the bytes still land on disk correctly.
func TestDownload_NonTTYProgress(t *testing.T) {
	const body = "release-zip-bytes-payload"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(body)) // net/http sets Content-Length for a known body
	}))
	t.Cleanup(srv.Close)

	orig := releaseRepo
	releaseRepo = "owner/repo"
	t.Cleanup(func() { releaseRepo = orig })

	c := &commandContext{deps: Deps{}.withDefaults()}
	dst := filepath.Join(t.TempDir(), "out.zip")

	var buf bytes.Buffer
	if err := c.download(context.Background(), &buf, srv.URL, "agent-orchestrator.zip", dst); err != nil {
		t.Fatalf("download failed: %v", err)
	}

	// Bytes on disk are intact.
	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != body {
		t.Fatalf("downloaded %q, want %q", got, body)
	}

	out := buf.String()
	if strings.Contains(out, "\r") {
		t.Fatalf("non-TTY progress must not emit carriage returns, got %q", out)
	}
	// Start line: asset name, size, and repo are all present.
	if !strings.Contains(out, "Downloading Agent Orchestrator (agent-orchestrator.zip, ") {
		t.Fatalf("missing start line in %q", out)
	}
	if !strings.Contains(out, "from owner/repo...") {
		t.Fatalf("start line missing repo in %q", out)
	}
	// Done line is present (the only per-copy line off a TTY).
	if !strings.Contains(out, "Downloaded ") {
		t.Fatalf("missing done line in %q", out)
	}
}

// TestDownload_NoContentLengthOmitsSize proves the start line drops the size
// segment when the server omits Content-Length, and still reports transferred
// bytes on the done line.
func TestDownload_NoContentLengthOmitsSize(t *testing.T) {
	const body = "streamed-bytes"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		// Chunked transfer (no Content-Length): flush so the header omits length.
		w.Header().Set("Transfer-Encoding", "chunked")
		_, _ = w.Write([]byte(body))
		if fl, ok := w.(http.Flusher); ok {
			fl.Flush()
		}
	}))
	t.Cleanup(srv.Close)

	c := &commandContext{deps: Deps{}.withDefaults()}
	dst := filepath.Join(t.TempDir(), "out.bin")

	var buf bytes.Buffer
	if err := c.download(context.Background(), &buf, srv.URL, "asset.bin", dst); err != nil {
		t.Fatalf("download failed: %v", err)
	}
	out := buf.String()
	// No "~<size>)" segment when Content-Length is absent.
	if strings.Contains(out, "~") {
		t.Fatalf("size segment should be omitted without Content-Length, got %q", out)
	}
	if !strings.Contains(out, "Downloading Agent Orchestrator (asset.bin) from") {
		t.Fatalf("unexpected start line in %q", out)
	}
	if !strings.Contains(out, "Downloaded ") {
		t.Fatalf("missing done line in %q", out)
	}
}

func TestHumanBytes(t *testing.T) {
	cases := map[int64]string{
		0:         "0 B",
		512:       "512 B",
		1024:      "1.0 KiB",
		1536:      "1.5 KiB",
		314572800: "300.0 MiB",
	}
	for n, want := range cases {
		if got := humanBytes(n); got != want {
			t.Errorf("humanBytes(%d) = %q, want %q", n, got, want)
		}
	}
}

// swapPreferredAppPath replaces the preferred-location seam and returns a
// restore func.
func swapPreferredAppPath(fn func() string) func() {
	orig := preferredAppPath
	preferredAppPath = fn
	return func() { preferredAppPath = orig }
}

// swapScanLocations replaces the scan-location seam and returns a restore func.
func swapScanLocations(fn func() []string) func() {
	orig := appScanLocations
	appScanLocations = fn
	return func() { appScanLocations = orig }
}
