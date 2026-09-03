package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type browserRequestCapture struct {
	path       string
	capability string
	body       browserCommandRequestDTO
}

func browserCLIServer(t *testing.T, capture *browserRequestCapture) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capture.path = r.URL.RequestURI()
		capture.capability = r.Header.Get(browserCapabilityHeader)
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodGet && r.URL.Path == "/api/v1/browser/status" {
			_, _ = io.WriteString(w, `{"sessionId":"ao-1","connected":true,"transport":"electron-webcontents-debugger","state":"ready","provider":"electron","target":{"tabId":"t1","url":"http://localhost:3000","title":"App","loading":false,"snapshotGeneration":2}}`)
			return
		}
		if r.Method == http.MethodPost && r.URL.Path == "/api/v1/browser/observe" {
			var input browserObserveRequestDTO
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
				t.Fatalf("decode observe: %v", err)
			}
			capture.body = browserCommandRequestDTO{SessionID: input.SessionID, Action: "observe", Args: map[string]any{
				"tabId": input.TabID, "interactiveOnly": input.InteractiveOnly, "includeScreenshot": input.IncludeScreenshot, "includeProblems": input.IncludeProblems,
			}}
			_, _ = io.WriteString(w, `{"requestId":"r-observe","sessionId":"ao-1","observation":{"state":"ready","provider":"electron","target":{"tabId":"t1","url":"http://localhost:3000","title":"App","loading":false,"snapshotGeneration":3},"snapshot":{"url":"http://localhost:3000","title":"App","generation":3,"text":"button Save [ref=e1]","totalNodes":1,"truncated":false},"screenshot":{"mimeType":"image/png","data":"cG5n","width":10,"height":20,"url":"http://localhost:3000","untrustedExternalContent":true},"problems":{"console":[],"errors":[]}}}`)
			return
		}
		if r.Method == http.MethodPost && r.URL.Path == "/api/v1/browser/actions" {
			var input browserActionRequestDTO
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
				t.Fatalf("decode action: %v", err)
			}
			args := map[string]any{"expectedState": input.ExpectedState}
			if input.Ref != "" {
				args["ref"] = input.Ref
			}
			if input.Target != nil {
				args["target"] = input.Target
			}
			switch input.Action {
			case "fill", "type":
				args["text"] = input.Text
			case "press":
				args["key"] = input.Key
			case "scroll":
				args["direction"], args["amount"] = input.Direction, float64(input.Amount)
			case "select":
				args["value"] = input.Value
			}
			if input.AllowStaleRemap {
				args["allowStaleRemap"] = true
			}
			if input.Confirmed {
				args["confirmed"] = true
			}
			if input.WaitAfter != nil {
				args["waitAfter"] = input.WaitAfter
			}
			capture.body = browserCommandRequestDTO{SessionID: input.SessionID, Action: input.Action, Args: args}
			_, _ = io.WriteString(w, `{"requestId":"r1","sessionId":"ao-1","action":"`+input.Action+`","result":{"ok":true}}`)
			return
		}
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/browser/commands" {
			http.NotFound(w, r)
			return
		}
		if err := json.NewDecoder(r.Body).Decode(&capture.body); err != nil {
			t.Fatalf("decode command: %v", err)
		}
		result := `{"ok":true}`
		switch capture.body.Action {
		case "snapshot":
			result = `{"text":"button Save [ref=e1]"}`
		case "screenshot":
			result = `{"data":"cG5n","width":10,"height":20}`
		case "tabs":
			result = `{"activeTabId":"t2","tabs":[{"id":"t1","title":"First","url":"http://localhost:3000/","active":false},{"id":"t2","title":"Second","url":"http://localhost:4173/","active":true}]}`
		case "network-start", "network-status":
			result = `{"active":true,"metadataOnly":true,"tabId":"t1","requestCount":1,"maxEntries":200}`
		case "network-list", "network-stop":
			result = `{"active":false,"metadataOnly":true,"tabId":"t1","requestCount":1,"maxEntries":200,"requests":[{"method":"GET","url":"https://api.example.test/items?token=%5Bredacted%5D","resourceType":"xhr","status":200,"durationMs":42}]}`
		case "network-clear":
			result = `{"active":true,"metadataOnly":true,"tabId":"t1","requestCount":0,"maxEntries":200}`
		}
		_, _ = io.WriteString(w, `{"requestId":"r1","sessionId":"ao-1","action":"`+capture.body.Action+`","result":`+result+`}`)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func setBrowserIdentity(t *testing.T) {
	t.Helper()
	t.Setenv("AO_SESSION_ID", "ao-1")
	t.Setenv("AO_BROWSER_CAPABILITY", "capability-1")
}

func TestBrowserStatusAndSnapshot(t *testing.T) {
	setBrowserIdentity(t)
	cfg := setConfigEnv(t)
	capture := &browserRequestCapture{}
	srv := browserCLIServer(t, capture)
	writeRunFileFor(t, cfg, srv)
	deps := Deps{ProcessAlive: func(int) bool { return true }}

	out, errOut, err := executeCLI(t, deps, "browser", "status")
	if err != nil || !strings.Contains(out, "Browser: ready") || !strings.Contains(out, "Target: t1") {
		t.Fatalf("status err=%v stderr=%s stdout=%s", err, errOut, out)
	}
	if capture.path != "/api/v1/browser/status?sessionId=ao-1" {
		t.Fatalf("status path = %q", capture.path)
	}
	if capture.capability != "capability-1" {
		t.Fatalf("status capability = %q", capture.capability)
	}
	out, errOut, err = executeCLI(t, deps, "browser", "snapshot", "--interactive")
	if err != nil || !strings.Contains(out, "button Save [ref=e1]") {
		t.Fatalf("snapshot err=%v stderr=%s stdout=%s", err, errOut, out)
	}
	if capture.body.SessionID != "ao-1" || capture.body.Action != "snapshot" || capture.body.Args["interactive"] != true {
		t.Fatalf("command = %#v", capture.body)
	}
}

func TestBrowserObserveRequestsCompositeEvidenceAndWritesImage(t *testing.T) {
	setBrowserIdentity(t)
	cfg := setConfigEnv(t)
	capture := &browserRequestCapture{}
	srv := browserCLIServer(t, capture)
	writeRunFileFor(t, cfg, srv)
	target := filepath.Join(t.TempDir(), "observation.png")

	out, errOut, err := executeCLI(t, Deps{ProcessAlive: func(int) bool { return true }},
		"browser", "observe", "--interactive", "--problems", "--screenshot-out", target)
	if err != nil {
		t.Fatalf("observe err=%v stderr=%s", err, errOut)
	}
	if capture.path != "/api/v1/browser/observe" || capture.body.Action != "observe" ||
		capture.body.Args["interactiveOnly"] != true || capture.body.Args["includeScreenshot"] != true || capture.body.Args["includeProblems"] != true {
		t.Fatalf("observe request = path %q body %#v", capture.path, capture.body)
	}
	data, readErr := os.ReadFile(target)
	if readErr != nil || string(data) != "png" || !strings.Contains(out, "button Save [ref=e1]") || !strings.Contains(out, "Problems: 0 console, 0 page errors") {
		t.Fatalf("observe data=%q readErr=%v out=%q", data, readErr, out)
	}
}

func TestBrowserClickAndWaitArguments(t *testing.T) {
	setBrowserIdentity(t)
	cfg := setConfigEnv(t)
	capture := &browserRequestCapture{}
	srv := browserCLIServer(t, capture)
	writeRunFileFor(t, cfg, srv)
	deps := Deps{ProcessAlive: func(int) bool { return true }}

	if _, _, err := executeCLI(t, deps, "browser", "click", "e2", "--tab", "t1", "--expected-url", "http://localhost/page", "--generation", "7"); err != nil {
		t.Fatal(err)
	}
	if capture.body.Action != "click" || capture.body.Args["ref"] != "e2" {
		t.Fatalf("click = %#v", capture.body)
	}
	expected, _ := capture.body.Args["expectedState"].(map[string]any)
	if expected["tabId"] != "t1" || expected["expectedUrl"] != "http://localhost/page" || expected["snapshotGeneration"] != float64(7) {
		t.Fatalf("click expected state = %#v", expected)
	}
	if _, _, err := executeCLI(t, deps, "browser", "wait", "--text", "Ready", "--timeout", "2500"); err != nil {
		t.Fatal(err)
	}
	if capture.body.Action != "wait" || capture.body.Args["text"] != "Ready" || capture.body.Args["timeoutMs"] != float64(2500) {
		t.Fatalf("wait = %#v", capture.body)
	}
}

func TestBrowserExpandedWaitArguments(t *testing.T) {
	setBrowserIdentity(t)
	cfg := setConfigEnv(t)
	capture := &browserRequestCapture{}
	srv := browserCLIServer(t, capture)
	writeRunFileFor(t, cfg, srv)
	deps := Deps{ProcessAlive: func(int) bool { return true }}

	tests := []struct {
		name string
		args []string
		key  string
		want any
	}{
		{name: "text disappears", args: []string{"--text-gone", "Saving..."}, key: "textGone", want: "Saving..."},
		{name: "selector disappears", args: []string{"--selector-gone", ".spinner"}, key: "selectorGone", want: ".spinner"},
		{name: "page load", args: []string{"--load"}, key: "load", want: true},
		{name: "DOM stability", args: []string{"--dom-stable", "750"}, key: "stableMs", want: float64(750)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, _, err := executeCLI(t, deps, append([]string{"browser", "wait"}, tt.args...)...); err != nil {
				t.Fatal(err)
			}
			if capture.body.Action != "wait" || capture.body.Args[tt.key] != tt.want {
				t.Fatalf("wait command = %#v", capture.body)
			}
		})
	}
}

func TestBrowserCoreInteractionArguments(t *testing.T) {
	setBrowserIdentity(t)
	cfg := setConfigEnv(t)
	capture := &browserRequestCapture{}
	srv := browserCLIServer(t, capture)
	writeRunFileFor(t, cfg, srv)
	deps := Deps{ProcessAlive: func(int) bool { return true }}

	tests := []struct {
		name   string
		args   []string
		action string
		want   map[string]any
	}{
		{name: "type", args: []string{"type", "e1", "hello"}, action: "type", want: map[string]any{"ref": "e1", "text": "hello"}},
		{name: "press", args: []string{"press", "Control+A"}, action: "press", want: map[string]any{"key": "Control+A"}},
		{name: "hover", args: []string{"hover", "e2"}, action: "hover", want: map[string]any{"ref": "e2"}},
		{name: "highlight", args: []string{"highlight", "e2"}, action: "highlight", want: map[string]any{"ref": "e2"}},
		{name: "unhighlight", args: []string{"unhighlight"}, action: "unhighlight", want: map[string]any{}},
		{name: "tabs", args: []string{"tabs"}, action: "tabs", want: map[string]any{}},
		{name: "tab new", args: []string{"tab", "new", "localhost:4173"}, action: "tab-new", want: map[string]any{"url": "localhost:4173"}},
		{name: "tab select", args: []string{"tab", "select", "t2"}, action: "tab-select", want: map[string]any{"tabId": "t2"}},
		{name: "tab close", args: []string{"tab", "close", "t1"}, action: "tab-close", want: map[string]any{"tabId": "t1"}},
		{name: "scroll", args: []string{"scroll", "down", "--amount", "450"}, action: "scroll", want: map[string]any{"direction": "down", "amount": float64(450)}},
		{name: "select", args: []string{"select", "e3", "large"}, action: "select", want: map[string]any{"ref": "e3", "value": "large"}},
		{name: "check", args: []string{"check", "e4"}, action: "check", want: map[string]any{"ref": "e4"}},
		{name: "uncheck", args: []string{"uncheck", "e4"}, action: "uncheck", want: map[string]any{"ref": "e4"}},
		{name: "get", args: []string{"get", "value", "e5"}, action: "get", want: map[string]any{"property": "value", "ref": "e5"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			commandArgs := append([]string{"browser"}, tt.args...)
			if tt.action == "type" || tt.action == "press" || tt.action == "scroll" || tt.action == "select" || tt.action == "check" || tt.action == "uncheck" {
				commandArgs = append(commandArgs, "--tab", "t1", "--expected-url", "http://localhost/page", "--generation", "4")
			}
			if _, _, err := executeCLI(t, deps, commandArgs...); err != nil {
				t.Fatal(err)
			}
			if capture.body.Action != tt.action {
				t.Fatalf("action = %q, want %q", capture.body.Action, tt.action)
			}
			for key, want := range tt.want {
				if got := capture.body.Args[key]; got != want {
					t.Fatalf("%s arg %q = %#v, want %#v", tt.name, key, got, want)
				}
			}
		})
	}
}

func TestBrowserSemanticLocatorAndPostActionWait(t *testing.T) {
	setBrowserIdentity(t)
	cfg := setConfigEnv(t)
	capture := &browserRequestCapture{}
	srv := browserCLIServer(t, capture)
	writeRunFileFor(t, cfg, srv)
	deps := Deps{ProcessAlive: func(int) bool { return true }}

	_, _, err := executeCLI(t, deps, "browser", "click",
		"--role", "button", "--name", "Save", "--exact",
		"--tab", "t2", "--expected-url", "http://localhost/settings", "--generation", "14",
		"--wait-stable", "300", "--wait-timeout", "2000", "--confirm-external")
	if err != nil {
		t.Fatal(err)
	}
	target, _ := capture.body.Args["target"].(map[string]any)
	waitAfter, _ := capture.body.Args["waitAfter"].(map[string]any)
	if target["role"] != "button" || target["name"] != "Save" || target["exact"] != true {
		t.Fatalf("semantic target = %#v", target)
	}
	if waitAfter["stableMs"] != float64(300) || waitAfter["timeoutMs"] != float64(2000) {
		t.Fatalf("waitAfter = %#v", waitAfter)
	}
	if capture.body.Args["confirmed"] != true {
		t.Fatalf("confirmed = %#v", capture.body.Args["confirmed"])
	}
}

func TestBrowserMutationRequiresObservedTargetState(t *testing.T) {
	setBrowserIdentity(t)
	cfg := setConfigEnv(t)
	capture := &browserRequestCapture{}
	srv := browserCLIServer(t, capture)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{ProcessAlive: func(int) bool { return true }}, "browser", "click", "e1")
	if err == nil || !strings.Contains(err.Error(), "require --tab, --expected-url, and --generation") {
		t.Fatalf("expected target-state usage error, got %v", err)
	}
}

func TestBrowserVerifyChecksPostconditionAndCapturesVisualEvidence(t *testing.T) {
	setBrowserIdentity(t)
	cfg := setConfigEnv(t)
	capture := &browserRequestCapture{}
	srv := browserCLIServer(t, capture)
	writeRunFileFor(t, cfg, srv)
	target := filepath.Join(t.TempDir(), "verified.png")

	out, errOut, err := executeCLI(t, Deps{ProcessAlive: func(int) bool { return true }},
		"browser", "verify", "--tab", "t1", "--text", "Saved", "--timeout", "2500", "--screenshot-out", target)
	if err != nil {
		t.Fatalf("verify err=%v stderr=%s", err, errOut)
	}
	if capture.path != "/api/v1/browser/observe" || capture.body.Action != "observe" || capture.body.Args["tabId"] != "t1" || capture.body.Args["includeScreenshot"] != true || capture.body.Args["includeProblems"] != false {
		t.Fatalf("verify observation = path %q body %#v", capture.path, capture.body)
	}
	data, readErr := os.ReadFile(target)
	if readErr != nil || string(data) != "png" || !strings.Contains(out, "button Save [ref=e1]") {
		t.Fatalf("verify data=%q readErr=%v out=%q", data, readErr, out)
	}
}

func TestBrowserTabsPrintStableIDsAndActiveTab(t *testing.T) {
	setBrowserIdentity(t)
	cfg := setConfigEnv(t)
	capture := &browserRequestCapture{}
	srv := browserCLIServer(t, capture)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{ProcessAlive: func(int) bool { return true }}, "browser", "tabs")
	if err != nil {
		t.Fatalf("tabs err=%v stderr=%s", err, errOut)
	}
	if !strings.Contains(out, "  t1") || !strings.Contains(out, "* t2") {
		t.Fatalf("tabs output = %q", out)
	}
}

func TestBrowserNetworkCommandsAreExplicitAndReadable(t *testing.T) {
	setBrowserIdentity(t)
	cfg := setConfigEnv(t)
	capture := &browserRequestCapture{}
	srv := browserCLIServer(t, capture)
	writeRunFileFor(t, cfg, srv)
	deps := Deps{ProcessAlive: func(int) bool { return true }}

	out, errOut, err := executeCLI(t, deps, "browser", "network", "start", "--duration", "45")
	if err != nil {
		t.Fatalf("network start err=%v stderr=%s", err, errOut)
	}
	if capture.body.Action != "network-start" || capture.body.Args["durationSeconds"] != float64(45) {
		t.Fatalf("network start = %#v", capture.body)
	}
	if !strings.Contains(out, "active") || !strings.Contains(out, "metadata only") {
		t.Fatalf("network start output = %q", out)
	}

	out, errOut, err = executeCLI(t, deps, "browser", "network", "list")
	if err != nil {
		t.Fatalf("network list err=%v stderr=%s", err, errOut)
	}
	if capture.body.Action != "network-list" ||
		!strings.Contains(out, "GET 200 xhr 42ms") ||
		!strings.Contains(out, "token=%5Bredacted%5D") {
		t.Fatalf("network list command=%#v output=%q", capture.body, out)
	}

	if _, _, err := executeCLI(t, deps, "browser", "network", "start", "--duration", "301"); ExitCode(err) != 2 {
		t.Fatalf("network duration error = %v code=%d", err, ExitCode(err))
	}
}

func TestBrowserScreenshotWritesWithoutOverwrite(t *testing.T) {
	setBrowserIdentity(t)
	cfg := setConfigEnv(t)
	capture := &browserRequestCapture{}
	srv := browserCLIServer(t, capture)
	writeRunFileFor(t, cfg, srv)
	deps := Deps{ProcessAlive: func(int) bool { return true }}
	target := filepath.Join(t.TempDir(), "shot.png")

	out, errOut, err := executeCLI(t, deps, "browser", "screenshot", target)
	if err != nil {
		t.Fatalf("screenshot err=%v stderr=%s", err, errOut)
	}
	data, err := os.ReadFile(target)
	if err != nil || string(data) != "png" || !strings.Contains(out, "10x20") {
		t.Fatalf("screenshot data=%q err=%v out=%s", data, err, out)
	}
	if _, _, err := executeCLI(t, deps, "browser", "screenshot", target); err == nil || !strings.Contains(err.Error(), "refusing to overwrite") {
		t.Fatalf("overwrite error = %v", err)
	}
}

func TestBrowserRequiresSessionAndValidWait(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "")
	if _, _, err := executeCLI(t, Deps{}, "browser", "status"); ExitCode(err) != 2 {
		t.Fatalf("status error = %v code=%d", err, ExitCode(err))
	}
	t.Setenv("AO_SESSION_ID", "ao-1")
	if _, _, err := executeCLI(t, Deps{}, "browser", "status"); ExitCode(err) != 2 {
		t.Fatalf("missing capability error = %v code=%d", err, ExitCode(err))
	}
	t.Setenv("AO_BROWSER_CAPABILITY", "capability-1")
	if _, _, err := executeCLI(t, Deps{}, "browser", "wait", "--text", "x", "--url", "y"); ExitCode(err) != 2 {
		t.Fatalf("wait error = %v code=%d", err, ExitCode(err))
	}
	if _, _, err := executeCLI(t, Deps{}, "browser", "wait", "--dom-stable", "5000", "--timeout", "1000"); ExitCode(err) != 2 {
		t.Fatalf("dom-stable timeout error = %v code=%d", err, ExitCode(err))
	}
	if _, _, err := executeCLI(t, Deps{}, "browser", "get"); ExitCode(err) != 2 {
		t.Fatalf("get error = %v code=%d", err, ExitCode(err))
	}
}

func TestBrowserPreservesDaemonErrorEnvelopeAndRequestID(t *testing.T) {
	setBrowserIdentity(t)
	cfg := setConfigEnv(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_, _ = io.WriteString(w, `{"error":"conflict","code":"SESSION_TERMINATED","message":"Session is terminated","requestId":"req-browser-1"}`)
	}))
	t.Cleanup(srv.Close)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{ProcessAlive: func(int) bool { return true }}, "browser", "snapshot")
	if ExitCode(err) != 1 {
		t.Fatalf("exit code = %d, error = %v", ExitCode(err), err)
	}
	if !strings.Contains(err.Error(), "Session is terminated (SESSION_TERMINATED)") ||
		!strings.Contains(err.Error(), "[request req-browser-1]") {
		t.Fatalf("error did not preserve daemon envelope: %v", err)
	}
}
