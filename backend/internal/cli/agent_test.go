package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestAgentListEnsuresDisplayReadinessByDefault(t *testing.T) {
	cfg := setConfigEnv(t)
	var requests []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		appendPrimaryRequest(&requests, r)
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost && r.URL.Path == "/api/v1/agents/readiness/ensure" {
			_, _ = io.WriteString(w, readinessAgentsJSON("codex", "not_installed", "unknown"))
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{ProcessAlive: func(int) bool { return true }}, "agent", "ls")
	if err != nil {
		t.Fatalf("agent ls failed: %v stderr=%s", err, errOut)
	}
	if !strings.Contains(out, "codex") || !strings.Contains(out, "needs install") {
		t.Fatalf("output missing table labels:\n%s", out)
	}
	want := []string{"POST /api/v1/agents/readiness/ensure"}
	if !reflect.DeepEqual(requests, want) {
		t.Fatalf("requests=%#v want %#v", requests, want)
	}
}

func TestAgentListRefreshAndStatuses(t *testing.T) {
	cfg := setConfigEnv(t)
	var requests []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		appendPrimaryRequest(&requests, r)
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost && r.URL.Path == "/api/v1/agents/readiness/ensure" {
			_, _ = io.WriteString(w, `{"agents":[`+
				`{"id":"aider","label":"Aider","installation":{"state":"installed"},"authentication":{"state":"unauthorized"},"effectiveReadiness":"not_ready","usageCount":0},`+
				`{"id":"codex","label":"Codex","installation":{"state":"installed"},"authentication":{"state":"authorized"},"effectiveReadiness":"ready","usageCount":0},`+
				`{"id":"goose","label":"Goose","installation":{"state":"installed"},"authentication":{"state":"unknown"},"effectiveReadiness":"unknown","usageCount":0},`+
				`{"id":"opencode","label":"OpenCode","installation":{"state":"not_installed"},"authentication":{"state":"unknown"},"effectiveReadiness":"not_ready","usageCount":0}]}`)
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{ProcessAlive: func(int) bool { return true }}, "agent", "ls", "--refresh")
	if err != nil {
		t.Fatalf("agent ls --refresh failed: %v stderr=%s", err, errOut)
	}
	for _, want := range []string{"codex", "authorized", "aider", "needs auth", "goose", "auth unknown", "opencode", "needs install"} {
		if !strings.Contains(out, want) {
			t.Fatalf("output missing %q:\n%s", want, out)
		}
	}
	want := []string{"POST /api/v1/agents/readiness/ensure"}
	if !reflect.DeepEqual(requests, want) {
		t.Fatalf("requests=%#v want %#v", requests, want)
	}
}

func TestAgentListJSONEmitsRawCatalog(t *testing.T) {
	cfg := setConfigEnv(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost && r.URL.Path == "/api/v1/agents/readiness/ensure" {
			_, _ = io.WriteString(w, authorizedAgentsJSON("codex"))
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{ProcessAlive: func(int) bool { return true }}, "agent", "ls", "--json")
	if err != nil {
		t.Fatalf("agent ls --json failed: %v stderr=%s", err, errOut)
	}
	var inv agentInventory
	if err := json.Unmarshal([]byte(out), &inv); err != nil {
		t.Fatalf("json output did not decode: %v\n%s", err, out)
	}
	if len(inv.Supported) != 1 || len(inv.Installed) != 1 || len(inv.Authorized) != 1 {
		t.Fatalf("inventory = %#v", inv)
	}
}

func TestReadinessInventoryProjectsAuthNotApplicableAsLegacyAuthorized(t *testing.T) {
	inv := readinessInventory(agentReadinessResponse{Agents: []agentReadinessSnapshot{{
		ID: "local", Label: "Local",
		Installation:   agentReadinessObservation{State: "installed"},
		Authentication: agentReadinessObservation{State: "not_applicable"},
	}}})
	if len(inv.Authorized) != 1 || inv.Authorized[0].AuthStatus != "authorized" {
		t.Fatalf("legacy authorized projection = %#v", inv.Authorized)
	}
}

func TestAgentProfileListEnsuresCapacityAndRendersMissingValues(t *testing.T) {
	cfg := setConfigEnv(t)
	var requests []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		appendPrimaryRequest(&requests, r)
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost && r.URL.Path == "/api/v1/agents/codex/profiles/capacity/ensure" {
			_, _ = io.WriteString(w, `{"profiles":[{"id":"existing","label":"Existing Codex profile","source":"existing","status":"valid","reasonCode":"profile_valid","reason":"available","authentication":{"state":"authorized","freshness":"fresh","reasonCode":"authorized","reason":"signed in"},"authMethod":"chatgpt","usableByCurrentLaunches":true,"capacity":{"state":"unknown","freshness":"stale","reasonCode":"capacity_not_checked","reason":"not checked","additionalBuckets":[]}}],"capabilities":{}}`)
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{ProcessAlive: func(int) bool { return true }}, "agent", "profile", "ls")
	if err != nil {
		t.Fatalf("agent profile ls failed: %v stderr=%s", err, errOut)
	}
	for _, want := range []string{"ID", "CAPACITY", "existing", "unknown", "—"} {
		if !strings.Contains(out, want) {
			t.Fatalf("output missing %q:\n%s", want, out)
		}
	}
	if want := []string{"POST /api/v1/agents/codex/profiles/capacity/ensure"}; !reflect.DeepEqual(requests, want) {
		t.Fatalf("requests=%#v want %#v", requests, want)
	}
}

func TestAgentProfileListJSONPreservesCapacityBuckets(t *testing.T) {
	cfg := setConfigEnv(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost && r.URL.Path == "/api/v1/agents/codex/profiles/capacity/ensure" {
			_, _ = io.WriteString(w, `{"profiles":[{"id":"existing","label":"Existing Codex profile","source":"existing","status":"valid","reasonCode":"profile_valid","reason":"available","authentication":{"state":"authorized","freshness":"fresh","reasonCode":"authorized","reason":"signed in"},"authMethod":"chatgpt","usableByCurrentLaunches":true,"capacity":{"state":"near_limit","freshness":"fresh","usedPercent":81,"reasonCode":"capacity_near_limit","reason":"near limit","overall":{"limitId":"codex","reached":"not_reached","primary":{"usedPercent":81}},"additionalBuckets":[{"limitId":"spark","reached":"not_reached","primary":{"usedPercent":25}}]}}],"capabilities":{"capacityRead":{"state":"supported"}}}`)
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{ProcessAlive: func(int) bool { return true }}, "agent", "profile", "list", "--json")
	if err != nil {
		t.Fatalf("agent profile list --json failed: %v stderr=%s", err, errOut)
	}
	var response map[string]any
	if err := json.Unmarshal([]byte(out), &response); err != nil {
		t.Fatalf("decode JSON output: %v\n%s", err, out)
	}
	if !strings.Contains(out, `"limitId": "spark"`) || !strings.Contains(out, `"usedPercent": 81`) {
		t.Fatalf("JSON output dropped full capacity data:\n%s", out)
	}
}

func TestAgentProfileListHasNoRefreshOrForceFlags(t *testing.T) {
	setConfigEnv(t)
	for _, flag := range []string{"--refresh", "--force"} {
		_, _, err := executeCLI(t, Deps{}, "agent", "profile", "ls", flag)
		if err == nil || ExitCode(err) != 2 {
			t.Fatalf("%s error = %v (exit %d), want usage exit 2", flag, err, ExitCode(err))
		}
	}
}
