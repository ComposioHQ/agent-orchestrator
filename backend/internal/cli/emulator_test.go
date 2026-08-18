package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type emulatorCLIServerState struct {
	deviceStatus androidEmulatorStatusDTO
	inputActions []androidInputActionDTO
	pngBytes     []byte
	uiTree       androidUINodeDTO
	startCalls   int
	stopCalls    int
}

func emulatorCLIServer(t *testing.T, state *emulatorCLIServerState) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/android-device/status":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(state.deviceStatus)
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/android-device/start":
			state.startCalls++
			w.WriteHeader(http.StatusAccepted)
			_ = json.NewEncoder(w).Encode(state.deviceStatus)
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/android-device/stop":
			state.stopCalls++
			_ = json.NewEncoder(w).Encode(state.deviceStatus)
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/android-device/screenshot":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(state.pngBytes)
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/android-device/ui-tree":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(state.uiTree)
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/android-device/input":
			var action androidInputActionDTO
			_ = json.NewDecoder(r.Body).Decode(&action)
			state.inputActions = append(state.inputActions, action)
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestEmulatorStatusCommand(t *testing.T) {
	cfg := setConfigEnv(t)
	state := &emulatorCLIServerState{deviceStatus: androidEmulatorStatusDTO{State: "running", AccelAvailable: true}}
	srv := emulatorCLIServer(t, state)
	writeRunFileFor(t, cfg, srv)
	deps := Deps{ProcessAlive: func(int) bool { return true }}

	out, errOut, err := executeCLI(t, deps, "android", "emulator", "status")
	if err != nil {
		t.Fatalf("status err=%v stderr=%s stdout=%s", err, errOut, out)
	}
	if !strings.Contains(out, "state: running") {
		t.Fatalf("status output = %q", out)
	}
}

func TestEmulatorStartAndStopCommands(t *testing.T) {
	cfg := setConfigEnv(t)
	state := &emulatorCLIServerState{}
	srv := emulatorCLIServer(t, state)
	writeRunFileFor(t, cfg, srv)
	deps := Deps{ProcessAlive: func(int) bool { return true }}

	if _, errOut, err := executeCLI(t, deps, "android", "emulator", "start"); err != nil {
		t.Fatalf("start err=%v stderr=%s", err, errOut)
	}
	if _, errOut, err := executeCLI(t, deps, "android", "emulator", "stop"); err != nil {
		t.Fatalf("stop err=%v stderr=%s", err, errOut)
	}
	if state.startCalls != 1 || state.stopCalls != 1 {
		t.Errorf("startCalls=%d stopCalls=%d, want 1 each", state.startCalls, state.stopCalls)
	}
}

func TestEmulatorTapCommand(t *testing.T) {
	cfg := setConfigEnv(t)
	state := &emulatorCLIServerState{}
	srv := emulatorCLIServer(t, state)
	writeRunFileFor(t, cfg, srv)
	deps := Deps{ProcessAlive: func(int) bool { return true }}

	if _, errOut, err := executeCLI(t, deps, "android", "emulator", "tap", "100", "200"); err != nil {
		t.Fatalf("tap err=%v stderr=%s", err, errOut)
	}
	if len(state.inputActions) != 1 || state.inputActions[0].Type != "tap" || state.inputActions[0].X != 100 || state.inputActions[0].Y != 200 {
		t.Errorf("inputActions = %+v, want one tap at (100,200)", state.inputActions)
	}
}

func TestEmulatorSwipeCommand(t *testing.T) {
	cfg := setConfigEnv(t)
	state := &emulatorCLIServerState{}
	srv := emulatorCLIServer(t, state)
	writeRunFileFor(t, cfg, srv)
	deps := Deps{ProcessAlive: func(int) bool { return true }}

	if _, errOut, err := executeCLI(t, deps, "android", "emulator", "swipe", "0", "1000", "0", "0"); err != nil {
		t.Fatalf("swipe err=%v stderr=%s", err, errOut)
	}
	if len(state.inputActions) != 1 || state.inputActions[0].Type != "swipe" || state.inputActions[0].Y != 1000 || state.inputActions[0].Y2 != 0 {
		t.Errorf("inputActions = %+v, want one swipe from y=1000 to y=0", state.inputActions)
	}
}

func TestEmulatorTypeCommand(t *testing.T) {
	cfg := setConfigEnv(t)
	state := &emulatorCLIServerState{}
	srv := emulatorCLIServer(t, state)
	writeRunFileFor(t, cfg, srv)
	deps := Deps{ProcessAlive: func(int) bool { return true }}

	if _, errOut, err := executeCLI(t, deps, "android", "emulator", "type", "hello world"); err != nil {
		t.Fatalf("type err=%v stderr=%s", err, errOut)
	}
	if len(state.inputActions) != 1 || state.inputActions[0].Type != "text" || state.inputActions[0].Text != "hello world" {
		t.Errorf("inputActions = %+v, want one text action", state.inputActions)
	}
}

func TestEmulatorPressKeyCommand(t *testing.T) {
	cfg := setConfigEnv(t)
	state := &emulatorCLIServerState{}
	srv := emulatorCLIServer(t, state)
	writeRunFileFor(t, cfg, srv)
	deps := Deps{ProcessAlive: func(int) bool { return true }}

	if _, errOut, err := executeCLI(t, deps, "android", "emulator", "press-key", "Home"); err != nil {
		t.Fatalf("press-key err=%v stderr=%s", err, errOut)
	}
	if len(state.inputActions) != 1 || state.inputActions[0].Type != "key" || state.inputActions[0].Key != "Home" {
		t.Errorf("inputActions = %+v, want one key=Home action", state.inputActions)
	}
}

func TestEmulatorScreenshotCommandSavesToFile(t *testing.T) {
	cfg := setConfigEnv(t)
	pngBytes := []byte{0x89, 'P', 'N', 'G', 1, 2, 3}
	state := &emulatorCLIServerState{pngBytes: pngBytes}
	srv := emulatorCLIServer(t, state)
	writeRunFileFor(t, cfg, srv)
	deps := Deps{ProcessAlive: func(int) bool { return true }}

	outPath := filepath.Join(t.TempDir(), "shot.png")
	out, errOut, err := executeCLI(t, deps, "android", "emulator", "screenshot", "--out", outPath)
	if err != nil {
		t.Fatalf("screenshot err=%v stderr=%s stdout=%s", err, errOut, out)
	}
	if !strings.Contains(out, outPath) {
		t.Errorf("screenshot output = %q, want it to mention the saved path %q", out, outPath)
	}
	saved, readErr := os.ReadFile(outPath)
	if readErr != nil {
		t.Fatalf("read saved screenshot: %v", readErr)
	}
	if string(saved) != string(pngBytes) {
		t.Errorf("saved bytes = %v, want the PNG bytes", saved)
	}
}

func TestEmulatorInspectUICommand(t *testing.T) {
	cfg := setConfigEnv(t)
	state := &emulatorCLIServerState{uiTree: androidUINodeDTO{
		Class: "android.widget.FrameLayout",
		Children: []androidUINodeDTO{
			{Class: "android.widget.Button", Text: "Close app", Clickable: true},
		},
	}}
	srv := emulatorCLIServer(t, state)
	writeRunFileFor(t, cfg, srv)
	deps := Deps{ProcessAlive: func(int) bool { return true }}

	out, errOut, err := executeCLI(t, deps, "android", "emulator", "inspect-ui")
	if err != nil {
		t.Fatalf("inspect-ui err=%v stderr=%s", err, errOut)
	}
	if !strings.Contains(out, "Close app") {
		t.Fatalf("inspect-ui output = %q, want it to mention the button text", out)
	}
}

func TestEmulatorFindSourceCommand(t *testing.T) {
	deps := Deps{ProcessAlive: func(int) bool { return true }}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "Dialog.kt"), []byte(`// handles aerr_close`), 0o644); err != nil {
		t.Fatal(err)
	}
	oldWd, _ := os.Getwd()
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(oldWd) })

	out, errOut, err := executeCLI(t, deps, "android", "emulator", "find-source", "aerr_close")
	if err != nil {
		t.Fatalf("find-source err=%v stderr=%s", err, errOut)
	}
	if !strings.Contains(out, "Dialog.kt") {
		t.Fatalf("find-source output = %q, want it to mention Dialog.kt", out)
	}
}
