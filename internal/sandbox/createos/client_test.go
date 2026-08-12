package createos

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Untrivial-ai/ao-cloud/internal/sandbox"
)

func newTestClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return New(Config{
		BaseURL:      server.URL,
		APIKey:       "secret-api-key",
		DefaultShape: "s-4vcpu-8gb",
		DefaultRoot:  "devbox:1",
		HTTPClient:   server.Client(),
	})
}

func TestCreateSendsShapeRootfsAndEnvironment(t *testing.T) {
	var received createSandboxRequest
	var apiKey string
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/sandboxes" {
			t.Errorf("request = %s %s, want POST /v1/sandboxes", r.Method, r.URL.Path)
		}
		apiKey = r.Header.Get("X-Api-Key")
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		writeJSON(w, http.StatusCreated, sandboxView{
			ID: "sbx-1", Status: "creating", Name: received.Name, VCPU: 4, MemMiB: 8192, DiskMiB: 10240,
		})
	})

	environment, err := client.Create(context.Background(), sandbox.Spec{
		Name:            SandboxName("session-1"),
		SessionID:       "session-1",
		Environment:     map[string]string{"AO_WORKER_BOOTSTRAP_TOKEN": "ticket"},
		AutoStopMinutes: 30,
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	if apiKey != "secret-api-key" {
		t.Errorf("X-Api-Key = %q, want the configured key", apiKey)
	}
	if received.Shape != "s-4vcpu-8gb" || received.RootFS != "devbox:1" {
		t.Errorf("shape/rootfs = %q/%q, want the configured defaults", received.Shape, received.RootFS)
	}
	if received.Name != "ao-session-1" {
		t.Errorf("name = %q, want ao-session-1", received.Name)
	}
	if received.Envs["AO_WORKER_BOOTSTRAP_TOKEN"] != "ticket" {
		t.Error("the bootstrap token was not passed as a sandbox env var")
	}
	if received.AutoPauseAfterSeconds != 1800 {
		t.Errorf("auto_pause_after_seconds = %d, want 1800", received.AutoPauseAfterSeconds)
	}
	if environment.ID != "sbx-1" || environment.State != sandbox.StateProvisioning {
		t.Errorf("environment = %+v, want sbx-1 in provisioning", environment)
	}
	if environment.Resource.Memory != 8 || environment.Resource.Disk != 10 {
		t.Errorf("resources = %+v, want 8 GiB memory and 10 GiB disk", environment.Resource)
	}
}

func TestCreateWithoutShapeFails(t *testing.T) {
	client := New(Config{BaseURL: "https://example.invalid", APIKey: "k"})
	if _, err := client.Create(context.Background(), sandbox.Spec{Name: "ao-1"}); err == nil {
		t.Fatal("Create() without a shape succeeded, want an error")
	}
}

func TestAutoPauseIsClampedToTheAPIRange(t *testing.T) {
	for _, tc := range []struct {
		minutes int
		want    int
	}{
		{minutes: 0, want: 0},
		{minutes: 1, want: 60},
		{minutes: 30, want: 1800},
		{minutes: 100000, want: 86400},
	} {
		if got := autoPauseSeconds(tc.minutes); got != tc.want {
			t.Errorf("autoPauseSeconds(%d) = %d, want %d", tc.minutes, got, tc.want)
		}
	}
}

func TestGetNotFoundMapsToErrNotFound(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"error":"no such sandbox"}`, http.StatusNotFound)
	})
	if _, err := client.Get(context.Background(), "sbx-gone"); !errors.Is(err, sandbox.ErrNotFound) {
		t.Fatalf("Get() error = %v, want ErrNotFound", err)
	}
}

func TestNonNotFoundErrorsBecomeHTTPErrorWithoutTheAPIKey(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"error":"scheduler is out of capacity"}`, http.StatusServiceUnavailable)
	})
	_, err := client.Get(context.Background(), "sbx-1")
	var httpErr *HTTPError
	if !errors.As(err, &httpErr) {
		t.Fatalf("Get() error = %v, want *HTTPError", err)
	}
	if httpErr.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503", httpErr.StatusCode)
	}
	if errors.Is(err, sandbox.ErrNotFound) {
		t.Error("a 503 was reported as ErrNotFound; the reconciler would destroy a live session")
	}
	if strings.Contains(err.Error(), "secret-api-key") {
		t.Error("the API key leaked into an error message")
	}
}

func TestErrorBodyIsTruncated(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = io.WriteString(w, strings.Repeat("x", (128<<10)))
	})
	_, err := client.Get(context.Background(), "sbx-1")
	var httpErr *HTTPError
	if !errors.As(err, &httpErr) {
		t.Fatalf("Get() error = %v, want *HTTPError", err)
	}
	if len(httpErr.Body) > maxErrorBody+4 {
		t.Errorf("error body length = %d, want it truncated near %d", len(httpErr.Body), maxErrorBody)
	}
}

func TestStateNormalization(t *testing.T) {
	cases := map[string]string{
		"running":                sandbox.StateRunning,
		"paused":                 sandbox.StatePaused,
		"destroying":             sandbox.StateDeleting,
		"destroyed":              sandbox.StateDeleted,
		"creating":               sandbox.StateProvisioning,
		"pausing":                sandbox.StateProvisioning,
		"resuming":               sandbox.StateProvisioning,
		"forking":                sandbox.StateProvisioning,
		"error":                  sandbox.StateProvisioning,
		"failed":                 sandbox.StateProvisioning,
		"RUNNING":                sandbox.StateRunning,
		"some-future-state":      sandbox.StateProvisioning,
		"":                       sandbox.StateProvisioning,
		"almost-running-but-not": sandbox.StateProvisioning,
	}
	for status, want := range cases {
		if got := normalizeState(status); got != want {
			t.Errorf("normalizeState(%q) = %q, want %q", status, got, want)
		}
	}
}

// CreateOS pages by offset against an unpaged total, so a match on any page but
// the first only turns up if the client advances the offset correctly.
func TestFindBySessionMatchesOnNameAcrossPages(t *testing.T) {
	var offsets []string
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		offset := r.URL.Query().Get("offset")
		offsets = append(offsets, offset)
		if offset == "0" {
			writePage(w, []sandboxView{
				{ID: "sbx-other", Status: "running", Name: "ao-session-other"},
			}, 0, 2)
			return
		}
		writePage(w, []sandboxView{
			{ID: "sbx-1", Status: "running", Name: "ao-session-1"},
		}, 1, 2)
	})

	environment, found, err := client.FindBySession(context.Background(), "session-1")
	if err != nil {
		t.Fatalf("FindBySession() error = %v", err)
	}
	if !found || environment.ID != "sbx-1" {
		t.Fatalf("FindBySession() = %+v, %v; want sbx-1 found on page 2", environment, found)
	}
	if len(offsets) != 2 || offsets[0] != "0" || offsets[1] != "1" {
		t.Errorf("offsets requested = %v, want [0 1]", offsets)
	}
}

// Without a stop condition the caller would keep asking for pages past the end
// until it hit maxListPages, turning one lookup into 50 requests.
func TestFindBySessionStopsAtTheReportedTotal(t *testing.T) {
	pages := 0
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		pages++
		writePage(w, []sandboxView{
			{ID: "sbx-other", Status: "running", Name: "ao-session-other"},
		}, 0, 1)
	})
	if _, found, err := client.FindBySession(context.Background(), "session-1"); err != nil || found {
		t.Fatalf("FindBySession() = %v, %v; want not found", found, err)
	}
	if pages != 1 {
		t.Errorf("requested %d pages, want 1 — the total said there were no more", pages)
	}
}

func TestFindBySessionIgnoresDestroyedSandboxes(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		writePage(w, []sandboxView{
			{ID: "sbx-old", Status: "destroyed", Name: "ao-session-1"},
		}, 0, 1)
	})
	_, found, err := client.FindBySession(context.Background(), "session-1")
	if err != nil {
		t.Fatalf("FindBySession() error = %v", err)
	}
	if found {
		t.Fatal("a destroyed sandbox was adopted as the session's live environment")
	}
}

// A response that is not wrapped must fail loudly. Silently reading it as a
// zero value is what let an empty sandbox id reach the reconciler.
func TestUnwrappedResponseIsRejected(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		writeRaw(w, http.StatusOK, sandboxView{ID: "sbx-1", Status: "running"})
	})
	if _, err := client.Get(context.Background(), "sbx-1"); err == nil {
		t.Fatal("Get() accepted a response with no JSend envelope")
	}
}

func TestStopPausesAndStartResumes(t *testing.T) {
	var paths []string
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	ctx := context.Background()
	if err := client.Stop(ctx, "sbx-1"); err != nil {
		t.Fatalf("Stop() error = %v", err)
	}
	if err := client.Start(ctx, "sbx-1"); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	want := []string{"/v1/sandboxes/sbx-1/pause", "/v1/sandboxes/sbx-1/resume"}
	for i, path := range want {
		if paths[i] != path {
			t.Errorf("call %d hit %s, want %s", i, paths[i], path)
		}
	}
}

func TestDeleteTreatsMissingSandboxAsSuccess(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "gone", http.StatusNotFound)
	})
	if err := client.Delete(context.Background(), "sbx-1"); err != nil {
		t.Fatalf("Delete() of a missing sandbox error = %v, want nil", err)
	}
}

func TestRecreateDeletesThenCreates(t *testing.T) {
	var calls []string
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		switch r.Method {
		case http.MethodPost:
			writeJSON(w, http.StatusCreated, sandboxView{ID: "sbx-2", Status: "creating", Name: "ao-session-1"})
		case http.MethodGet:
			writeJSON(w, http.StatusOK, sandboxView{ID: "sbx-1", Status: "destroyed"})
		default:
			writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		}
	})
	client.deletePoll = time.Millisecond

	environment, err := client.Recreate(context.Background(), "sbx-1", sandbox.Spec{
		Name: SandboxName("session-1"), Shape: "s-4vcpu-8gb",
	})
	if err != nil {
		t.Fatalf("Recreate() error = %v", err)
	}
	if environment.ID != "sbx-2" {
		t.Errorf("recreated id = %q, want sbx-2", environment.ID)
	}
	want := []string{"DELETE /v1/sandboxes/sbx-1", "GET /v1/sandboxes/sbx-1", "POST /v1/sandboxes"}
	for i, call := range want {
		if calls[i] != call {
			t.Errorf("call %d = %q, want %q", i, calls[i], call)
		}
	}
}

// The name is only free once the old VM leaves destroying, so the replacement
// must not be created while the delete is still settling.
func TestRecreateWaitsForTheOldSandboxToGoAway(t *testing.T) {
	var calls []string
	gets := 0
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		switch r.Method {
		case http.MethodPost:
			writeJSON(w, http.StatusCreated, sandboxView{ID: "sbx-2", Status: "creating"})
		case http.MethodGet:
			gets++
			if gets < 3 {
				writeJSON(w, http.StatusOK, sandboxView{ID: "sbx-1", Status: "destroying"})
				return
			}
			http.Error(w, "gone", http.StatusNotFound)
		default:
			writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		}
	})
	client.deletePoll = time.Millisecond

	if _, err := client.Recreate(context.Background(), "sbx-1", sandbox.Spec{Shape: "s-4vcpu-8gb"}); err != nil {
		t.Fatalf("Recreate() error = %v", err)
	}
	if gets != 3 {
		t.Errorf("polled %d times, want 3 — until the sandbox was gone", gets)
	}
	if last := calls[len(calls)-1]; last != "POST /v1/sandboxes" {
		t.Errorf("last call = %q, want the create to come after the delete settled", last)
	}
}

func TestRecreateGivesUpWhenTheDeleteNeverSettles(t *testing.T) {
	created := false
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			created = true
			writeJSON(w, http.StatusCreated, sandboxView{ID: "sbx-2"})
		case http.MethodGet:
			writeJSON(w, http.StatusOK, sandboxView{ID: "sbx-1", Status: "destroying"})
		default:
			writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		}
	})
	client.deletePoll = time.Millisecond

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := client.Recreate(ctx, "sbx-1", sandbox.Spec{Shape: "s-4vcpu-8gb"}); err == nil {
		t.Fatal("Recreate() succeeded while the old sandbox was still destroying")
	}
	if created {
		t.Error("the replacement was created into a name the old sandbox still held")
	}
}

func TestBootstrapWorkerUploadsThenLaunches(t *testing.T) {
	var calls []string
	var uploaded []byte
	var uploadPath string
	var execCommands []execRequest
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		switch {
		case strings.HasSuffix(r.URL.Path, "/files"):
			uploadPath = r.URL.Query().Get("path")
			uploaded, _ = io.ReadAll(r.Body)
			writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		case strings.HasSuffix(r.URL.Path, "/exec"):
			var request execRequest
			_ = json.NewDecoder(r.Body).Decode(&request)
			execCommands = append(execCommands, request)
			writeJSON(w, http.StatusOK, map[string]any{"result": map[string]any{"exit_code": 0}})
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	})

	err := client.BootstrapWorker(context.Background(), "sbx-1", sandbox.WorkerBootstrap{
		Binary:      []byte("ELF-worker"),
		Destination: "/usr/local/bin/ao-worker",
	})
	if err != nil {
		t.Fatalf("BootstrapWorker() error = %v", err)
	}

	// The binary lands beside its destination, never on top of it: overwriting
	// the running worker in place would fail with ETXTBSY on every repair.
	if uploadPath != "/usr/local/bin/ao-worker.new" {
		t.Errorf("upload path = %q, want the staging path beside the destination", uploadPath)
	}
	if string(uploaded) != "ELF-worker" {
		t.Errorf("uploaded %q, want the worker binary bytes", uploaded)
	}
	if len(execCommands) != 5 {
		t.Fatalf("exec called %d times, want mkdir, chmod, pkill, mv, and launch", len(execCommands))
	}
	if execCommands[0].Cmd != "mkdir" || execCommands[1].Cmd != "chmod" {
		t.Errorf("exec sequence = %q/%q, want mkdir then chmod", execCommands[0].Cmd, execCommands[1].Cmd)
	}
	stop := strings.Join(execCommands[2].Args, " ")
	if !strings.Contains(stop, "pkill") || !strings.Contains(stop, "|| true") {
		t.Errorf("stop command = %v, want a pkill that tolerates no match", execCommands[2].Args)
	}
	if execCommands[3].Cmd != "mv" {
		t.Errorf("swap command = %q, want the staged binary renamed into place", execCommands[3].Cmd)
	}
	if got := strings.Join(execCommands[3].Args, " "); got != "-f /usr/local/bin/ao-worker.new /usr/local/bin/ao-worker" {
		t.Errorf("swap args = %q, want the staging path renamed over the destination", got)
	}
	launch := strings.Join(execCommands[4].Args, " ")
	if execCommands[4].Cmd != "bash" || !strings.Contains(launch, "ao-worker") {
		t.Errorf("launch command = %s %v, want the worker started under bash", execCommands[4].Cmd, execCommands[4].Args)
	}
}

func TestBootstrapWorkerRejectsARelativeDestination(t *testing.T) {
	client := newTestClient(t, func(http.ResponseWriter, *http.Request) {
		t.Error("a relative destination reached the API")
	})
	err := client.BootstrapWorker(context.Background(), "sbx-1", sandbox.WorkerBootstrap{
		Binary: []byte("x"), Destination: "bin/ao-worker",
	})
	if err == nil {
		t.Fatal("BootstrapWorker() accepted a relative destination")
	}
}

func TestBootstrapWorkerFailsOnNonZeroExit(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/files") {
			writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"result": map[string]any{"exit_code": 127, "stderr": "chmod: not found"},
		})
	})
	err := client.BootstrapWorker(context.Background(), "sbx-1", sandbox.WorkerBootstrap{
		Binary: []byte("x"), Destination: "/usr/local/bin/ao-worker",
	})
	if err == nil {
		t.Fatal("BootstrapWorker() ignored a non-zero exit code")
	}
}

// writeJSON answers the way CreateOS does: every payload wrapped in a JSend
// envelope, {"status":"success","data":{...}}. Tests that spoke the bare shape
// agreed with the client and with nothing else, which is how a client that
// never unwrapped the envelope stayed green.
func writeJSON(w http.ResponseWriter, status int, value any) {
	writeRaw(w, status, map[string]any{"status": "success", "data": value})
}

// writeRaw answers with an unwrapped body, for tests that check what happens
// when the envelope is missing or malformed.
func writeRaw(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

// writePage answers a list endpoint the way CreateOS does: items nested at
// data.data[] beside a pagination block counted against the unpaged total.
func writePage(w http.ResponseWriter, views []sandboxView, offset, total int) {
	writeRaw(w, http.StatusOK, map[string]any{
		"status": "success",
		"data": map[string]any{
			"data": views,
			"pagination": map[string]any{
				"total":  total,
				"limit":  listPageLimit,
				"offset": offset,
				"count":  len(views),
			},
		},
	})
}
