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

func TestProjectControlGet_UnconfiguredAndJSON(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := projectServer(t, http.StatusOK, `{"projectId":"demo","configured":false,"revision":0,"health":"unconfigured","confidence":"unknown"}`)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{ProcessAlive: func(int) bool { return true }}, "project", "control", "get", "demo")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.method != http.MethodGet || capture.path != "/api/v1/projects/demo/control" {
		t.Fatalf("request = %s %s", capture.method, capture.path)
	}
	if !strings.Contains(out, "Project demo control: unconfigured (revision 0)") {
		t.Fatalf("output = %q", out)
	}

	out, errOut, err = executeCLI(t, Deps{ProcessAlive: func(int) bool { return true }}, "project", "control", "get", "demo", "--json")
	if err != nil {
		t.Fatalf("json error: %v\nstderr=%s", err, errOut)
	}
	var got projectControl
	if err := json.Unmarshal([]byte(out), &got); err != nil || got.ProjectID != "demo" || got.Configured {
		t.Fatalf("json output = %q, parsed=%#v err=%v", out, got, err)
	}
}

func TestProjectOutcomeSet_InlineJSONPreservesCriterionContract(t *testing.T) {
	cfg := setConfigEnv(t)
	response := `{"projectId":"demo","configured":true,"revision":2,"health":"unknown","confidence":"unknown","outcome":{"id":"outcome-1","statement":"Ship safely","owner":"role:project-owner","criteria":[{"id":"criterion-stable","statement":"Tests pass","verificationMethod":"go test ./...","displayOrder":0}]}}`
	srv, capture := projectServer(t, http.StatusOK, response)
	writeRunFileFor(t, cfg, srv)
	input := `{"statement":"Ship safely","criteria":[{"id":"criterion-stable","statement":"Tests pass","verificationMethod":"go test ./...","displayOrder":0}],"expectedRevision":1,"idempotencyKey":"retry-2"}`

	out, errOut, err := executeCLI(t, Deps{ProcessAlive: func(int) bool { return true }}, "project", "outcome", "set", "demo", "--input-json", input)
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.method != http.MethodPut || capture.path != "/api/v1/projects/demo/outcome" {
		t.Fatalf("request = %s %s", capture.method, capture.path)
	}
	var sent setProjectOutcomeRequest
	if err := json.Unmarshal(capture.body, &sent); err != nil {
		t.Fatalf("decode request: %v", err)
	}
	if sent.ExpectedRevision != 1 || sent.IdempotencyKey != "retry-2" || len(sent.Criteria) != 1 || sent.Criteria[0].ID != "criterion-stable" || sent.Criteria[0].VerificationMethod != "go test ./..." {
		t.Fatalf("request = %#v", sent)
	}
	for _, want := range []string{"Project demo control (revision 2)", "Outcome: Ship safely", "Tests pass [go test ./...] (criterion-stable)"} {
		if !strings.Contains(out, want) {
			t.Fatalf("output missing %q:\n%s", want, out)
		}
	}
}

func TestProjectOutcomeSet_FileAndValidation(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := projectServer(t, http.StatusOK, `{"projectId":"demo","configured":true,"revision":1,"health":"unknown","confidence":"unknown","outcome":{"id":"outcome-1","statement":"Ship","owner":"role:project-owner","criteria":[]}}`)
	writeRunFileFor(t, cfg, srv)
	path := filepath.Join(t.TempDir(), "outcome.json")
	if err := os.WriteFile(path, []byte(`{"statement":"Ship","criteria":[],"expectedRevision":0,"idempotencyKey":"create-1"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	_, errOut, err := executeCLI(t, Deps{ProcessAlive: func(int) bool { return true }}, "project", "outcome", "set", "demo", "--file", path, "--json")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if !strings.Contains(string(capture.body), `"idempotencyKey":"create-1"`) {
		t.Fatalf("request body = %s", capture.body)
	}

	_, _, err = executeCLI(t, Deps{}, "project", "outcome", "set", "demo")
	if err == nil || ExitCode(err) != 2 || !strings.Contains(err.Error(), "exactly one of --file or --input-json is required") {
		t.Fatalf("missing input err = %v, exit=%d", err, ExitCode(err))
	}
	_, _, err = executeCLI(t, Deps{}, "project", "outcome", "set", "demo", "--input-json", `{}`, "--file", path)
	if err == nil || ExitCode(err) != 2 {
		t.Fatalf("mutually exclusive input err = %v", err)
	}
	_, _, err = executeCLI(t, Deps{}, "project", "outcome", "set", "demo", "--input-json", `{"statement":"Ship","criteria":[],"idempotencyKey":"missing-revision"}`)
	if err == nil || ExitCode(err) != 2 || !strings.Contains(err.Error(), "requires expectedRevision") {
		t.Fatalf("missing expectedRevision err = %v", err)
	}
}

type projectCapture struct {
	method string
	path   string
	body   []byte
}

func projectServer(t *testing.T, status int, respBody string) (*httptest.Server, *projectCapture) {
	t.Helper()
	capture := &projectCapture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capture.method = r.Method
		capture.path = r.URL.Path
		data, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read request body: %v", err)
		}
		capture.body = data
		if !strings.HasPrefix(r.URL.Path, "/api/v1/projects") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, respBody)
	}))
	t.Cleanup(srv.Close)
	return srv, capture
}

func TestProjectSetConfig_TrackerIntakeFlags(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := projectServer(t, http.StatusOK, `{"project":{"id":"demo","path":"/repo/demo"}}`)
	writeRunFileFor(t, cfg, srv)

	_, errOut, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "project", "set-config", "demo", "--tracker-intake", "--tracker-repo", "acme/demo", "--tracker-assignee", "alice")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.method != http.MethodPut || capture.path != "/api/v1/projects/demo/config" {
		t.Fatalf("request = %s %s, want PUT /api/v1/projects/demo/config", capture.method, capture.path)
	}
	var got setConfigRequest
	if err := json.Unmarshal(capture.body, &got); err != nil {
		t.Fatalf("decode request: %v\nbody=%s", err, capture.body)
	}
	if !got.Config.TrackerIntake.Enabled || got.Config.TrackerIntake.Provider != "github" || got.Config.TrackerIntake.Repo != "acme/demo" || got.Config.TrackerIntake.Assignee != "alice" {
		t.Fatalf("tracker intake request = %#v", got.Config.TrackerIntake)
	}
}

func TestProjectSetConfig_TrackerIntakeJSON(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := projectServer(t, http.StatusOK, `{"project":{"id":"demo","path":"/repo/demo"}}`)
	writeRunFileFor(t, cfg, srv)

	_, errOut, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "project", "set-config", "demo", "--config-json", `{"worker":{"agent":"amp","agentConfig":{"mode":"ultra"}},"trackerIntake":{"enabled":true,"provider":"github","assignee":"alice"}}`)
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	var got setConfigRequest
	if err := json.Unmarshal(capture.body, &got); err != nil {
		t.Fatalf("decode request: %v\nbody=%s", err, capture.body)
	}
	if !got.Config.TrackerIntake.Enabled || got.Config.TrackerIntake.Provider != "github" || got.Config.TrackerIntake.Assignee != "alice" {
		t.Fatalf("tracker intake request = %#v", got.Config.TrackerIntake)
	}
	if got.Config.Worker.Agent != "amp" || got.Config.Worker.AgentConfig.Mode != "ultra" {
		t.Fatalf("worker config = %#v, want preserved amp ultra mode", got.Config.Worker)
	}
}

func TestBuildProjectConfigTrackerIntakeFlags(t *testing.T) {
	got, err := buildProjectConfig(projectSetConfigOptions{
		trackerIntake:   true,
		trackerRepo:     "acme/demo",
		trackerAssignee: "alice",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !got.TrackerIntake.Enabled || got.TrackerIntake.Provider != "github" || got.TrackerIntake.Repo != "acme/demo" || got.TrackerIntake.Assignee != "alice" {
		t.Fatalf("tracker intake config = %#v", got.TrackerIntake)
	}
}

func TestProjectList_Success(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := projectServer(t, http.StatusOK, `{"projects":[{"id":"zeta","name":"Zeta","sessionPrefix":"zeta"},{"id":"alpha","name":"Alpha","sessionPrefix":"alpha","resolveError":"config missing"}]}`)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "project", "ls")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.method != http.MethodGet || capture.path != "/api/v1/projects" {
		t.Fatalf("request = %s %s, want GET /api/v1/projects", capture.method, capture.path)
	}
	if !strings.Contains(out, "ID") || !strings.Contains(out, "SESSION PREFIX") {
		t.Fatalf("output missing table header:\n%s", out)
	}
	if strings.Index(out, "alpha") > strings.Index(out, "zeta") {
		t.Fatalf("projects should be sorted by id in output:\n%s", out)
	}
	if !strings.Contains(out, "degraded: config missing") {
		t.Fatalf("output missing degraded status:\n%s", out)
	}
}

func TestProjectList_JSON(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := projectServer(t, http.StatusOK, `{"projects":[{"id":"demo","name":"Demo","sessionPrefix":"demo"}]}`)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "project", "ls", "--json")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	var got projectListResult
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("decode json output: %v\nout=%s", err, out)
	}
	if len(got.Projects) != 1 || got.Projects[0].ID != "demo" {
		t.Fatalf("projects = %#v, want demo", got.Projects)
	}
}

func TestProjectList_Empty(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := projectServer(t, http.StatusOK, `{"projects":[]}`)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "project", "ls")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if !strings.Contains(out, "No projects registered") || !strings.Contains(out, "ao project add --path") {
		t.Fatalf("empty output missing hint:\n%s", out)
	}
}

func TestProjectGet_Success(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := projectServer(t, http.StatusOK, `{"status":"ok","project":{"id":"demo","name":"Demo","path":"/repo/demo","repo":"git@example.com:demo.git","defaultBranch":"main","agent":"codex"}}`)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "project", "get", "demo")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.method != http.MethodGet || capture.path != "/api/v1/projects/demo" {
		t.Fatalf("request = %s %s, want GET /api/v1/projects/demo", capture.method, capture.path)
	}
	for _, want := range []string{"Project demo (ok)", "name: Demo", "path: /repo/demo", "default branch: main", "agent: codex"} {
		if !strings.Contains(out, want) {
			t.Fatalf("output missing %q:\n%s", want, out)
		}
	}
}

func TestProjectGet_JSON(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := projectServer(t, http.StatusOK, `{"status":"degraded","project":{"id":"demo","name":"Demo","path":"/repo/demo","resolveError":"config missing","config":{"worker":{"agent":"amp","agentConfig":{"mode":"high"}}}}}`)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "project", "get", "demo", "--json")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.method != http.MethodGet || capture.path != "/api/v1/projects/demo" {
		t.Fatalf("request = %s %s, want GET /api/v1/projects/demo", capture.method, capture.path)
	}
	var got projectGetResult
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("decode json output: %v\nout=%s", err, out)
	}
	if got.Status != "degraded" || got.Project.ID != "demo" || got.Project.ResolveError != "config missing" {
		t.Fatalf("get json = %#v, want degraded demo with resolve error", got)
	}
	if got.Project.Config == nil || got.Project.Config.Worker.AgentConfig.Mode != "high" {
		t.Fatalf("get json worker config = %#v, want preserved amp high mode", got.Project.Config)
	}
}

func TestProjectGet_MissingArg(t *testing.T) {
	setConfigEnv(t)
	_, _, err := executeCLI(t, Deps{}, "project", "get")
	if err == nil {
		t.Fatal("expected missing arg error")
	}
	if got := ExitCode(err); got != 2 {
		t.Fatalf("exit code = %d, want 2", got)
	}
}

func TestProjectGet_NotFound(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := projectServer(t, http.StatusNotFound, `{"error":"not_found","code":"PROJECT_NOT_FOUND","message":"Unknown project"}`)
	writeRunFileFor(t, cfg, srv)

	_, errOut, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "project", "get", "missing")
	if err == nil {
		t.Fatal("expected not found error")
	}
	if got := ExitCode(err); got != 1 {
		t.Fatalf("exit code = %d, want 1", got)
	}
	if !strings.Contains(err.Error(), "PROJECT_NOT_FOUND") && !strings.Contains(errOut, "PROJECT_NOT_FOUND") {
		t.Fatalf("error did not surface not found envelope: %v\nstderr=%s", err, errOut)
	}
}

func TestProjectSetConfig_RulesFlags(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := projectServer(t, http.StatusOK, `{"status":"ok","project":{"id":"demo","config":{"agentRules":"Run tests.","agentRulesFile":"docs/rules.md","orchestratorRules":"Delegate."}}}`)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "project", "set-config", "demo",
		"--agent-rules", "Run tests.",
		"--agent-rules-file", "docs/rules.md",
		"--orchestrator-rules", "Delegate.",
	)
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.method != http.MethodPut || capture.path != "/api/v1/projects/demo/config" {
		t.Fatalf("request = %s %s, want PUT /api/v1/projects/demo/config", capture.method, capture.path)
	}
	var got setConfigRequest
	if err := json.Unmarshal(capture.body, &got); err != nil {
		t.Fatalf("decode request body: %v\nbody=%s", err, capture.body)
	}
	if got.Config.AgentRules != "Run tests." || got.Config.AgentRulesFile != "docs/rules.md" || got.Config.OrchestratorRules != "Delegate." {
		t.Fatalf("rules config = %#v", got.Config)
	}
	if !strings.Contains(out, "updated config for project demo") {
		t.Fatalf("output missing update message:\n%s", out)
	}
}

func TestProjectRemove_RequiresID(t *testing.T) {
	setConfigEnv(t)
	_, _, err := executeCLI(t, Deps{}, "project", "rm")
	if err == nil {
		t.Fatal("expected missing id error")
	}
	if got := ExitCode(err); got != 2 {
		t.Fatalf("exit code = %d, want 2", got)
	}
}

func TestProjectRemove_NotFound(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := projectServer(t, http.StatusNotFound, `{"error":"not_found","code":"PROJECT_NOT_FOUND","message":"Unknown project"}`)
	writeRunFileFor(t, cfg, srv)

	_, errOut, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "project", "rm", "missing", "--yes")
	if err == nil {
		t.Fatal("expected not found error")
	}
	if got := ExitCode(err); got != 1 {
		t.Fatalf("exit code = %d, want 1", got)
	}
	if !strings.Contains(err.Error(), "PROJECT_NOT_FOUND") && !strings.Contains(errOut, "PROJECT_NOT_FOUND") {
		t.Fatalf("error did not surface not found envelope: %v\nstderr=%s", err, errOut)
	}
}

func TestProjectRemove_AbortsWhenConfirmationDoesNotMatch(t *testing.T) {
	setConfigEnv(t)
	out, _, err := executeCLI(t, Deps{
		In: strings.NewReader("nope\n"),
	}, "project", "rm", "demo")
	if err != nil {
		t.Fatalf("unexpected abort error: %v", err)
	}
	if !strings.Contains(out, "Type the project id to confirm") || !strings.Contains(out, "aborted") {
		t.Fatalf("output missing prompt/abort:\n%s", out)
	}
}

func TestProjectRemove_DeletesAfterConfirmation(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := projectServer(t, http.StatusOK, `{"ok":true,"id":"demo"}`)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{
		In:           strings.NewReader("demo\n"),
		ProcessAlive: func(int) bool { return true },
	}, "project", "rm", "demo")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.method != http.MethodDelete || capture.path != "/api/v1/projects/demo" {
		t.Fatalf("request = %s %s, want DELETE /api/v1/projects/demo", capture.method, capture.path)
	}
	if !strings.Contains(out, "removed project demo") {
		t.Fatalf("output missing removal message:\n%s", out)
	}
}

func TestProjectRemove_JSONDocumentedEnvelope(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := projectServer(t, http.StatusOK, `{"ok":true,"id":"demo"}`)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{
		In:           strings.NewReader("wrong\n"),
		ProcessAlive: func(int) bool { return true },
	}, "project", "rm", "demo", "--yes", "--json")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.method != http.MethodDelete || capture.path != "/api/v1/projects/demo" {
		t.Fatalf("request = %s %s, want DELETE /api/v1/projects/demo", capture.method, capture.path)
	}
	var got projectRemoveResult
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("decode json output: %v\nout=%s", err, out)
	}
	if !got.OK || got.ID != "demo" || got.ProjectID != "" {
		t.Fatalf("remove json = %#v, want documented ok/id envelope", got)
	}
}

func TestProjectRemove_JSONBackendEnvelope(t *testing.T) {
	cfg := setConfigEnv(t)
	removedStorageDir := false
	srv, _ := projectServer(t, http.StatusOK, `{"projectId":"demo","removedStorageDir":false}`)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "project", "rm", "demo", "--yes", "--json")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	var got projectRemoveResult
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("decode json output: %v\nout=%s", err, out)
	}
	if got.ProjectID != "demo" || got.RemovedStorageDir == nil || *got.RemovedStorageDir != removedStorageDir {
		t.Fatalf("remove json = %#v, want backend projectId/removedStorageDir envelope", got)
	}
}

func TestProjectRemove_EmptySuccessFallsBackToRequestedID(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := projectServer(t, http.StatusNoContent, ``)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "project", "rm", "demo", "--yes")
	if err != nil {
		t.Fatalf("unexpected error for empty 2xx body: %v\nstderr=%s", err, errOut)
	}
	if !strings.Contains(out, "removed project demo") {
		t.Fatalf("output missing fallback removal id:\n%s", out)
	}
}

func TestProjectRemove_YesSkipsConfirmationAndSupportsBackendRemoveEnvelope(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := projectServer(t, http.StatusOK, `{"projectId":"demo","removedStorageDir":false}`)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{
		In:           strings.NewReader("wrong\n"),
		ProcessAlive: func(int) bool { return true },
	}, "project", "rm", "demo", "--yes")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.method != http.MethodDelete || capture.path != "/api/v1/projects/demo" {
		t.Fatalf("request = %s %s, want DELETE /api/v1/projects/demo", capture.method, capture.path)
	}
	if strings.Contains(out, "Type the project id") || !strings.Contains(out, "removed project demo") {
		t.Fatalf("--yes output should skip prompt and print removal:\n%s", out)
	}
}
