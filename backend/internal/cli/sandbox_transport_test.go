package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

func TestSandboxCommandMatrix(t *testing.T) {
	t.Setenv(sandboxControlPlaneEnv, "https://control.example")
	t.Setenv(sandboxCapabilityEnv, defaultCapabilityPath)
	t.Setenv(sandboxRoleEnv, "")

	want := map[sandboxOperation]sandboxRoute{
		sandboxStatus:       {commandPath: "ao status", operation: sandboxStatus, method: http.MethodGet, pathTemplate: "/api/cloud/v1/worker/status"},
		sandboxReadList:     {commandPath: "ao session ls", operation: sandboxReadList, method: http.MethodGet, pathTemplate: "/api/cloud/v1/worker/sessions"},
		sandboxReadOne:      {commandPath: "ao session get", operation: sandboxReadOne, method: http.MethodGet, pathTemplate: "/api/cloud/v1/worker/sessions/{sessionId}"},
		sandboxKill:         {commandPath: "ao session kill", operation: sandboxKill, method: http.MethodDelete, pathTemplate: "/api/cloud/v1/worker/sessions/{sessionId}", idempotent: true},
		sandboxSpawn:        {commandPath: "ao spawn", operation: sandboxSpawn, method: http.MethodPost, pathTemplate: "/api/cloud/v1/worker/sessions", coordinatorOnly: true, idempotent: true},
		sandboxMessageRead:  {operation: sandboxMessageRead, method: http.MethodGet, pathTemplate: "/api/cloud/v1/worker/sessions/{sessionId}/messages"},
		sandboxSend:         {commandPath: "ao send", operation: sandboxSend, method: http.MethodPost, pathTemplate: "/api/cloud/v1/worker/sessions/{sessionId}/messages", idempotent: true},
		sandboxClaimPR:      {commandPath: "ao session claim-pr", operation: sandboxClaimPR, method: http.MethodPost, pathTemplate: "/api/cloud/v1/worker/sessions/{sessionId}/pr/claim"},
		sandboxReadPR:       {operation: sandboxReadPR, method: http.MethodGet, pathTemplate: "/api/cloud/v1/worker/sessions/{sessionId}/pr"},
		sandboxReviewList:   {commandPath: "ao review ls", operation: sandboxReviewList, method: http.MethodGet, pathTemplate: "/api/cloud/v1/worker/sessions/{sessionId}/reviews"},
		sandboxReviewSubmit: {commandPath: "ao review submit", operation: sandboxReviewSubmit, method: http.MethodPost, pathTemplate: "/api/cloud/v1/worker/sessions/{sessionId}/reviews/submit"},
	}
	if fmt.Sprint(sandboxRoutes) != fmt.Sprint(want) {
		t.Fatalf("sandbox route table = %#v, want %#v", sandboxRoutes, want)
	}
	for _, route := range want {
		if route.commandPath == "" {
			continue
		}
		if err := (&commandContext{}).guardSandboxCommand(commandByPath(t, route.commandPath)); !errors.Is(err, errSandboxContractPending) {
			t.Errorf("guard %s = %v, want pending shared schema", route.commandPath, err)
		}
	}
}

func TestSandboxRefusesLocalOnlyCommands(t *testing.T) {
	t.Setenv(sandboxControlPlaneEnv, "https://control.example")
	t.Setenv(sandboxCapabilityEnv, defaultCapabilityPath)

	for _, commandPath := range []string{
		"ao start",
		"ao stop",
		"ao doctor",
		"ao project ls",
		"ao agent ls",
		"ao session cleanup",
		"ao session restore",
		"ao pr merge",
		"ao pr resolve-comments",
		"ao review cancel",
		"ao review trigger",
		"ao preview",
		"ao browser status",
	} {
		t.Run(commandPath, func(t *testing.T) {
			err := (&commandContext{}).guardSandboxCommand(commandByPath(t, commandPath))
			if err == nil || !strings.Contains(err.Error(), "unavailable in sandbox mode") || !strings.Contains(err.Error(), "local AO daemon") {
				t.Fatalf("guard error = %v, want explicit local-only refusal", err)
			}
		})
	}
}

func TestSandboxRefusalStopsBeforeAnyTransport(t *testing.T) {
	t.Setenv(sandboxControlPlaneEnv, "https://control.example")
	t.Setenv(sandboxCapabilityEnv, "/must-not-be-read")

	tests := [][]string{
		{"start"},
		{"project", "ls"},
		{"pr", "merge", "42"},
		{"pr", "resolve-comments", "42"},
		{"review", "cancel", "worker-1"},
		{"review", "trigger", "worker-1"},
	}
	for _, args := range tests {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			calls := 0
			client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				calls++
				return nil, errors.New("transport must not be called")
			})}
			err := executeWithDeps(Deps{HTTPClient: client}, args)
			if err == nil || !strings.Contains(err.Error(), "unavailable in sandbox mode") {
				t.Fatalf("error = %v, want sandbox refusal", err)
			}
			if ExitCode(err) != 1 {
				t.Fatalf("exit code = %d, want 1", ExitCode(err))
			}
			if calls != 0 {
				t.Fatalf("transport calls = %d, want 0", calls)
			}
		})
	}
}

func TestSandboxSpawnRoleHintNeverAuthorizesLocally(t *testing.T) {
	t.Setenv(sandboxControlPlaneEnv, "https://control.example")
	t.Setenv(sandboxCapabilityEnv, defaultCapabilityPath)
	cmd := commandByPath(t, "ao spawn")

	for _, role := range []string{"", "worker", "coordinator", "unexpected"} {
		t.Setenv(sandboxRoleEnv, role)
		if err := (&commandContext{}).guardSandboxCommand(cmd); !errors.Is(err, errSandboxContractPending) {
			t.Fatalf("role %q produced role authorization instead of schema gate: %v", role, err)
		}
	}
}

func TestSandboxGuardIsInactiveWithoutControlPlaneEnv(t *testing.T) {
	t.Setenv(sandboxControlPlaneEnv, "")
	t.Setenv(sandboxCapabilityEnv, "/definitely/not/a/capability")
	for _, commandPath := range []string{"ao send", "ao status", "ao start", "ao project ls"} {
		if err := (&commandContext{}).guardSandboxCommand(commandByPath(t, commandPath)); err != nil {
			t.Errorf("%s changed local behavior: %v", commandPath, err)
		}
	}
}

func TestSandboxEnvAbsentPreservesLocalTransport(t *testing.T) {
	t.Setenv(sandboxControlPlaneEnv, "")
	// A path alone is never an activation signal. This also proves a host with
	// an unrelated file variable keeps using the byte-for-byte local path.
	t.Setenv(sandboxCapabilityEnv, "/not/read/by/local-mode")

	tests := []struct {
		name   string
		method string
		path   string
	}{
		{"get", http.MethodGet, "sessions/demo-1"},
		{"post", http.MethodPost, "sessions/demo-1/send"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cfg := setConfigEnv(t)
			var gotMethod, gotPath string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotMethod, gotPath = r.Method, r.URL.Path
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{}`)
			}))
			t.Cleanup(server.Close)
			writeRunFileFor(t, cfg, server)

			ctx := &commandContext{deps: Deps{ProcessAlive: func(int) bool { return true }}.withDefaults()}
			var err error
			if tc.method == http.MethodGet {
				err = ctx.getJSON(context.Background(), tc.path, &struct{}{})
			} else {
				err = ctx.postJSON(context.Background(), tc.path, map[string]string{"message": "hello"}, &struct{}{})
			}
			if err != nil {
				t.Fatal(err)
			}
			if gotMethod != tc.method || gotPath != "/api/v1/"+tc.path {
				t.Fatalf("local request = %s %s, want %s /api/v1/%s", gotMethod, gotPath, tc.method, tc.path)
			}
		})
	}
}

func TestLoadSandboxTransportValidation(t *testing.T) {
	t.Setenv(sandboxControlPlaneEnv, "https://control.example/base/")
	t.Setenv(sandboxCapabilityEnv, defaultCapabilityPath)
	transport, err := loadSandboxTransport()
	if err != nil {
		t.Fatal(err)
	}
	if got := transport.baseURL.String(); got != "https://control.example/base" {
		t.Fatalf("base URL = %q", got)
	}
	if transport.capabilityFile != defaultCapabilityPath {
		t.Fatalf("capability path = %q", transport.capabilityFile)
	}

	tests := []struct {
		name       string
		controlURL string
		file       string
		want       string
	}{
		{"missing URL", "", defaultCapabilityPath, "control-plane URL"},
		{"plain HTTP", "http://control.example", defaultCapabilityPath, "absolute HTTPS URL"},
		{"userinfo", "https://secret@control.example", defaultCapabilityPath, "absolute HTTPS URL"},
		{"query", "https://control.example?token=secret", defaultCapabilityPath, "absolute HTTPS URL"},
		{"fragment", "https://control.example/#secret", defaultCapabilityPath, "absolute HTTPS URL"},
		{"missing file env", "https://control.example", "", sandboxCapabilityEnv},
		{"relative file", "https://control.example", "relative/capability", "absolute path"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(sandboxControlPlaneEnv, tc.controlURL)
			t.Setenv(sandboxCapabilityEnv, tc.file)
			_, err := loadSandboxTransport()
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
			if strings.Contains(err.Error(), "secret") {
				t.Fatalf("diagnostic exposed URL credential/query/fragment: %v", err)
			}
		})
	}
}

func TestSandboxCapabilityValidation(t *testing.T) {
	dir := t.TempDir()
	valid := filepath.Join(dir, "valid")
	writeSandboxCapability(t, valid, "  opaque-token\n")
	transport := sandboxTransport{capabilityFile: valid}
	got, err := transport.readCapability()
	if err != nil || string(got) != "opaque-token" {
		t.Fatalf("read capability = %q, %v", got, err)
	}

	tests := []struct {
		name string
		make func(string)
		want string
	}{
		{"missing", func(string) {}, "read sandbox capability file"},
		{"directory", func(path string) { mustMkdir(t, path, 0o600) }, "regular file"},
		{"wrong mode", func(path string) { mustWriteFile(t, path, []byte("token"), 0o640) }, "mode must be 0600"},
		{"empty", func(path string) { mustWriteFile(t, path, nil, 0o600) }, "1 to 4096 bytes"},
		{"oversized", func(path string) {
			mustWriteFile(t, path, []byte(strings.Repeat("x", maxSandboxCapabilityLen+1)), 0o600)
		}, "1 to 4096 bytes"},
		{"embedded newline", func(path string) { mustWriteFile(t, path, []byte("one\ntwo"), 0o600) }, "invalid bearer bytes"},
		{"embedded space", func(path string) { mustWriteFile(t, path, []byte("one two"), 0o600) }, "invalid bearer bytes"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "capability")
			tc.make(path)
			_, err := (sandboxTransport{capabilityFile: path}).readCapability()
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}

	t.Run("symlink", func(t *testing.T) {
		target := filepath.Join(t.TempDir(), "target")
		writeSandboxCapability(t, target, "token")
		link := filepath.Join(t.TempDir(), "link")
		if err := os.Symlink(target, link); err != nil {
			t.Fatal(err)
		}
		_, err := (sandboxTransport{capabilityFile: link}).readCapability()
		if err == nil || !strings.Contains(err.Error(), "regular file") {
			t.Fatalf("symlink error = %v", err)
		}
	})
}

func TestSandboxTransportRereadsCapabilityAndMapsBearer(t *testing.T) {
	capabilityFile := filepath.Join(t.TempDir(), "capability")
	writeSandboxCapability(t, capabilityFile, "first-token")
	var authorizations []string
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorizations = append(authorizations, r.Header.Get("Authorization"))
		if r.URL.Path != "/base/api/cloud/v1/worker/example" {
			t.Errorf("path = %q", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	t.Cleanup(server.Close)
	t.Setenv(sandboxControlPlaneEnv, server.URL+"/base")
	t.Setenv(sandboxCapabilityEnv, capabilityFile)

	ctx := &commandContext{deps: Deps{HTTPClient: server.Client()}.withDefaults()}
	for _, token := range []string{"first-token", "rotated-token"} {
		writeSandboxCapability(t, capabilityFile, token)
		var out struct {
			OK bool `json:"ok"`
		}
		if err := ctx.doSandboxJSON(context.Background(), http.MethodPost, "/api/cloud/v1/worker/example", map[string]bool{"go": true}, &out); err != nil {
			t.Fatal(err)
		}
		if !out.OK {
			t.Fatal("response was not decoded")
		}
	}
	want := []string{"Bearer first-token", "Bearer rotated-token"}
	if fmt.Sprint(authorizations) != fmt.Sprint(want) {
		t.Fatalf("Authorization headers = %v, want %v", authorizations, want)
	}
}

func TestSandboxRouteMappings(t *testing.T) {
	capabilityFile := filepath.Join(t.TempDir(), "capability")
	writeSandboxCapability(t, capabilityFile, "route-token")
	t.Setenv(sandboxCapabilityEnv, capabilityFile)

	tests := []struct {
		operation      sandboxOperation
		sessionID      string
		wantMethod     string
		wantPath       string
		wantIdempotent bool
	}{
		{sandboxStatus, "", http.MethodGet, "/api/cloud/v1/worker/status", false},
		{sandboxReadList, "", http.MethodGet, "/api/cloud/v1/worker/sessions", false},
		{sandboxReadOne, "demo/1", http.MethodGet, "/api/cloud/v1/worker/sessions/demo%2F1", false},
		{sandboxKill, "demo/1", http.MethodDelete, "/api/cloud/v1/worker/sessions/demo%2F1", true},
		{sandboxSpawn, "", http.MethodPost, "/api/cloud/v1/worker/sessions", true},
		{sandboxMessageRead, "demo/1", http.MethodGet, "/api/cloud/v1/worker/sessions/demo%2F1/messages", false},
		{sandboxSend, "demo/1", http.MethodPost, "/api/cloud/v1/worker/sessions/demo%2F1/messages", true},
		{sandboxClaimPR, "demo/1", http.MethodPost, "/api/cloud/v1/worker/sessions/demo%2F1/pr/claim", false},
		{sandboxReadPR, "demo/1", http.MethodGet, "/api/cloud/v1/worker/sessions/demo%2F1/pr", false},
		{sandboxReviewList, "demo/1", http.MethodGet, "/api/cloud/v1/worker/sessions/demo%2F1/reviews", false},
		{sandboxReviewSubmit, "demo/1", http.MethodPost, "/api/cloud/v1/worker/sessions/demo%2F1/reviews/submit", false},
	}
	for _, tc := range tests {
		t.Run(string(tc.operation), func(t *testing.T) {
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != tc.wantMethod || r.URL.EscapedPath() != tc.wantPath {
					t.Errorf("request = %s %s, want %s %s", r.Method, r.URL.EscapedPath(), tc.wantMethod, tc.wantPath)
				}
				key := r.Header.Get("Idempotency-Key")
				if tc.wantIdempotent && key == "" {
					t.Error("missing Idempotency-Key")
				}
				if !tc.wantIdempotent && key != "" {
					t.Errorf("unexpected Idempotency-Key %q", key)
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{}`)
			}))
			t.Cleanup(server.Close)
			t.Setenv(sandboxControlPlaneEnv, server.URL)
			ctx := &commandContext{deps: Deps{HTTPClient: server.Client()}.withDefaults()}
			if err := ctx.doSandboxRoute(context.Background(), tc.operation, tc.sessionID, map[string]string{"test": "body"}, &struct{}{}); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestSandboxTransportPreservesEnvelopeAndRedactsCapability(t *testing.T) {
	const token = "do-not-log-this-token"
	capabilityFile := filepath.Join(t.TempDir(), "capability")
	writeSandboxCapability(t, capabilityFile, token)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = fmt.Fprintf(w, `{"error":"unauthorized","code":"AUTH_%s","message":"bad bearer %s","requestId":"req-%s"}`, token, token, token)
	}))
	t.Cleanup(server.Close)
	t.Setenv(sandboxControlPlaneEnv, server.URL)
	t.Setenv(sandboxCapabilityEnv, capabilityFile)

	err := (&commandContext{deps: Deps{HTTPClient: server.Client()}.withDefaults()}).doSandboxJSON(
		context.Background(), http.MethodGet, "/api/cloud/v1/worker/status", nil, nil,
	)
	if err == nil {
		t.Fatal("expected auth error")
	}
	if strings.Contains(err.Error(), token) {
		t.Fatalf("error exposed capability: %v", err)
	}
	for _, want := range []string{"bad bearer [REDACTED]", "AUTH_[REDACTED]", "request req-[REDACTED]"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q missing %q", err, want)
		}
	}
}

func TestSandboxTransportRedactsCapabilityFromTransportDiagnostic(t *testing.T) {
	const token = "transport-secret-token"
	capabilityFile := filepath.Join(t.TempDir(), "capability")
	writeSandboxCapability(t, capabilityFile, token)
	t.Setenv(sandboxControlPlaneEnv, "https://control.example")
	t.Setenv(sandboxCapabilityEnv, capabilityFile)
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, fmt.Errorf("diagnostic accidentally contained %s", token)
	})}
	err := (&commandContext{deps: Deps{HTTPClient: client}.withDefaults()}).doSandboxJSON(
		context.Background(), http.MethodGet, "/api/cloud/v1/worker/status", nil, nil,
	)
	if err == nil || strings.Contains(err.Error(), token) || !strings.Contains(err.Error(), "[REDACTED]") {
		t.Fatalf("transport error was not safely redacted: %v", err)
	}
}

func TestAPIResponseErrorSourcePreservesLocalDefault(t *testing.T) {
	if got := (apiResponseError{StatusCode: 502}).Error(); got != "daemon returned HTTP 502" {
		t.Fatalf("local fallback = %q", got)
	}
	if got := (apiResponseError{StatusCode: 502, Source: "control plane"}).Error(); got != "control plane returned HTTP 502" {
		t.Fatalf("sandbox fallback = %q", got)
	}
}

func commandByPath(t *testing.T, commandPath string) *cobra.Command {
	t.Helper()
	current := NewRootCommand(Deps{})
	parts := strings.Fields(strings.TrimPrefix(commandPath, "ao "))
	for _, part := range parts {
		var next *cobra.Command
		for _, candidate := range current.Commands() {
			if candidate.Name() == part {
				next = candidate
				break
			}
		}
		if next == nil {
			t.Fatalf("command path %q is not registered", commandPath)
		}
		current = next
	}
	return current
}

func writeSandboxCapability(t *testing.T, path, token string) {
	t.Helper()
	mustWriteFile(t, path, []byte(token), 0o600)
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
}

func mustWriteFile(t *testing.T, path string, data []byte, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, data, mode); err != nil {
		t.Fatal(err)
	}
}

func mustMkdir(t *testing.T, path string, mode os.FileMode) {
	t.Helper()
	if err := os.Mkdir(path, mode); err != nil {
		t.Fatal(err)
	}
}
