package docker

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"github.com/Untrivial-ai/ao-cloud/internal/sandbox"
)

func newTestClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client, err := New(Config{
		Host:        server.URL,
		WorkerImage: "ao-cloud-worker:test",
		Network:     "ao-cloud-test_default",
		Namespace:   "ao-cloud-test",
		HTTPClient:  server.Client(),
		APIVersion:  "1.43",
	})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func workerSpec() sandbox.Spec {
	return sandbox.Spec{
		Name:      "ao-session-1",
		SessionID: "session-1",
		OrgID:     "org-1",
		Environment: map[string]string{
			"AO_WORKER_BOOTSTRAP_TOKEN": "ticket",
			"AO_CLOUD_PUBLIC_URL":       "http://control-plane:8080",
		},
		Labels: map[string]string{
			"ao.managed":    "true",
			"ao.session_id": "session-1",
			"ao.org_id":     "org-1",
		},
	}
}

func TestCreateUsesLabeledVolumeAndStartsWorkerWithoutAutoPause(t *testing.T) {
	spec := workerSpec()
	workspace := workspaceName("ao-cloud-test", spec.SessionID)
	var calls []string
	var createRequest createContainerRequest
	var rawCreate string
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		switch {
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1.43/volumes/"):
			http.Error(w, "missing", http.StatusNotFound)
		case r.Method == http.MethodPost && r.URL.Path == "/v1.43/volumes/create":
			var request createVolumeRequest
			decodeJSON(t, r, &request)
			if request.Name != workspace {
				t.Errorf("volume name = %q, want %q", request.Name, workspace)
			}
			writeJSON(w, http.StatusCreated, volumeView{Name: request.Name, Labels: request.Labels})
		case r.Method == http.MethodPost && r.URL.Path == "/v1.43/containers/create":
			if got := r.URL.Query().Get("name"); got != containerName("ao-cloud-test", spec.SessionID) {
				t.Errorf("container name = %q", got)
			}
			var raw json.RawMessage
			decodeJSON(t, r, &raw)
			rawCreate = string(raw)
			if err := json.Unmarshal(raw, &createRequest); err != nil {
				t.Fatal(err)
			}
			writeJSON(w, http.StatusCreated, createContainerResponse{ID: "container-1"})
		case r.Method == http.MethodPost && r.URL.Path == "/v1.43/containers/container-1/start":
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodGet && r.URL.Path == "/v1.43/containers/container-1/json":
			writeJSON(w, http.StatusOK, ownedView("container-1", spec.SessionID, workspace, true))
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.String())
		}
	})

	environment, err := client.Create(context.Background(), spec)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if environment.ID != "container-1" || environment.State != sandbox.StateRunning {
		t.Errorf("environment = %+v", environment)
	}
	if createRequest.Image != "ao-cloud-worker:test" {
		t.Errorf("image = %q", createRequest.Image)
	}
	if createRequest.HostConfig.NetworkMode != "ao-cloud-test_default" {
		t.Errorf("network = %q", createRequest.HostConfig.NetworkMode)
	}
	if got := createRequest.HostConfig.Mounts; len(got) != 1 ||
		got[0].Source != workspace || got[0].Target != "/workspace" {
		t.Errorf("mounts = %+v", got)
	}
	wantEnvironment := []string{
		"AO_CLOUD_PUBLIC_URL=http://control-plane:8080",
		"AO_WORKER_BOOTSTRAP_TOKEN=ticket",
	}
	if !reflect.DeepEqual(createRequest.Env, wantEnvironment) {
		t.Errorf("environment = %v, want %v", createRequest.Env, wantEnvironment)
	}
	if strings.Contains(strings.ToLower(rawCreate), "pause") ||
		strings.Contains(strings.ToLower(rawCreate), "auto") {
		t.Errorf("create request unexpectedly configured auto-pause: %s", rawCreate)
	}
	wantCalls := []string{
		"GET /v1.43/volumes/" + workspace,
		"POST /v1.43/volumes/create",
		"POST /v1.43/containers/create",
		"POST /v1.43/containers/container-1/start",
		"GET /v1.43/containers/container-1/json",
	}
	if !reflect.DeepEqual(calls, wantCalls) {
		t.Errorf("calls = %v, want %v", calls, wantCalls)
	}
}

func TestFindBySessionUsesExactManagedLabels(t *testing.T) {
	workspace := workspaceName("ao-cloud-test", "session/with spaces")
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1.43/containers/json":
			var filters map[string][]string
			if err := json.Unmarshal([]byte(r.URL.Query().Get("filters")), &filters); err != nil {
				t.Fatal(err)
			}
			want := []string{
				"ao.managed=true",
				"ao.provider=docker",
				"ao.docker.namespace=ao-cloud-test",
				"ao.session_id=session/with spaces",
			}
			if !reflect.DeepEqual(filters["label"], want) {
				t.Errorf("label filters = %v, want %v", filters["label"], want)
			}
			writeJSON(w, http.StatusOK, []listedContainer{{ID: "container-1"}})
		case "/v1.43/containers/container-1/json":
			writeJSON(w, http.StatusOK, ownedView("container-1", "session/with spaces", workspace, true))
		default:
			t.Fatalf("unexpected request %s", r.URL.String())
		}
	})

	environment, found, err := client.FindBySession(context.Background(), "session/with spaces")
	if err != nil {
		t.Fatalf("FindBySession() error = %v", err)
	}
	if !found || environment.ID != "container-1" {
		t.Errorf("FindBySession() = %+v, %v", environment, found)
	}
}

func TestFindBySessionFailsClosedOnDuplicateContainers(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, []listedContainer{{ID: "one"}, {ID: "two"}})
	})
	if _, _, err := client.FindBySession(context.Background(), "session-1"); err == nil {
		t.Fatal("FindBySession() accepted duplicate managed containers")
	}
}

func TestDeleteRefusesUnmanagedContainer(t *testing.T) {
	deleted := false
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			deleted = true
		}
		writeJSON(w, http.StatusOK, containerView{
			ID: "container-1",
			Config: inspectConfig{Labels: map[string]string{
				labelManaged: "false",
			}},
		})
	})
	if err := client.Delete(context.Background(), "container-1"); err == nil {
		t.Fatal("Delete() accepted an unmanaged container")
	}
	if deleted {
		t.Fatal("Delete() sent a destructive request for an unmanaged container")
	}
}

func TestRecreatePreservesWorkspaceVolume(t *testing.T) {
	spec := workerSpec()
	workspace := workspaceName("ao-cloud-test", spec.SessionID)
	var calls []string
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1.43/containers/old/json":
			writeJSON(w, http.StatusOK, ownedView("old", spec.SessionID, workspace, true))
		case r.Method == http.MethodDelete && r.URL.Path == "/v1.43/containers/old":
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodGet && r.URL.Path == "/v1.43/volumes/"+workspace:
			writeJSON(w, http.StatusOK, volumeView{
				Name: workspace, Labels: managedLabels("ao-cloud-test", spec.SessionID, spec.OrgID, workspace),
			})
		case r.Method == http.MethodPost && r.URL.Path == "/v1.43/containers/create":
			writeJSON(w, http.StatusCreated, createContainerResponse{ID: "new"})
		case r.Method == http.MethodPost && r.URL.Path == "/v1.43/containers/new/start":
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodGet && r.URL.Path == "/v1.43/containers/new/json":
			writeJSON(w, http.StatusOK, ownedView("new", spec.SessionID, workspace, true))
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.String())
		}
	})

	environment, err := client.Recreate(context.Background(), "old", spec)
	if err != nil {
		t.Fatalf("Recreate() error = %v", err)
	}
	if environment.ID != "new" {
		t.Errorf("replacement = %+v", environment)
	}
	for _, call := range calls {
		if strings.HasPrefix(call, "DELETE /v1.43/volumes/") {
			t.Fatalf("Recreate() deleted the persistent workspace: %v", calls)
		}
	}
}

func TestDeleteRemovesContainerThenWorkspace(t *testing.T) {
	workspace := workspaceName("ao-cloud-test", "session-1")
	var calls []string
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		if r.Method == http.MethodGet {
			writeJSON(w, http.StatusOK, ownedView("container-1", "session-1", workspace, true))
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	if err := client.Delete(context.Background(), "container-1"); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	want := []string{
		"GET /v1.43/containers/container-1/json",
		"DELETE /v1.43/containers/container-1",
		"DELETE /v1.43/volumes/" + workspace,
	}
	if !reflect.DeepEqual(calls, want) {
		t.Errorf("calls = %v, want %v", calls, want)
	}
}

func TestGetMapsMissingContainerAndUnknownState(t *testing.T) {
	t.Run("missing", func(t *testing.T) {
		client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "missing", http.StatusNotFound)
		})
		if _, err := client.Get(context.Background(), "gone"); !errors.Is(err, sandbox.ErrNotFound) {
			t.Fatalf("Get() error = %v, want ErrNotFound", err)
		}
	})
	t.Run("unknown state", func(t *testing.T) {
		workspace := workspaceName("ao-cloud-test", "session-1")
		client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
			view := ownedView("container-1", "session-1", workspace, false)
			view.State.Status = "future-state"
			writeJSON(w, http.StatusOK, view)
		})
		environment, err := client.Get(context.Background(), "container-1")
		if err != nil {
			t.Fatal(err)
		}
		if environment.State != sandbox.StateProvisioning {
			t.Errorf("state = %q, want provisioning", environment.State)
		}
	})
}

func TestNewRejectsRemoteDaemonAndUnsafeInputs(t *testing.T) {
	if _, err := New(Config{
		Host: "tcp://docker.example:2375", WorkerImage: "worker", Namespace: "local",
	}); err == nil {
		t.Fatal("New() accepted a remote Docker daemon")
	}
	client := newTestClient(t, func(http.ResponseWriter, *http.Request) {
		t.Fatal("invalid spec reached Docker")
	})
	spec := workerSpec()
	spec.Environment["BAD\x00KEY"] = "value"
	if _, err := client.Create(context.Background(), spec); err == nil {
		t.Fatal("Create() accepted an environment key containing NUL")
	}
}

func TestNewNegotiatesTheEngineAPIVersion(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/version" {
			t.Fatalf("version negotiation hit %s", r.URL.Path)
		}
		writeJSON(w, http.StatusOK, map[string]string{"ApiVersion": "1.51"})
	}))
	defer server.Close()
	client, err := New(Config{
		Host:        server.URL,
		WorkerImage: "worker:test",
		Namespace:   "local",
		HTTPClient:  server.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if client.baseURL != server.URL+"/v1.51" {
		t.Errorf("base URL = %q, want negotiated v1.51", client.baseURL)
	}
}

func ownedView(id, sessionID, workspace string, running bool) containerView {
	return containerView{
		ID:   id,
		Name: "/" + containerName("ao-cloud-test", sessionID),
		State: containerState{
			Status:  "running",
			Running: running,
		},
		Config: inspectConfig{Labels: managedLabels("ao-cloud-test", sessionID, "org-1", workspace)},
		HostConfig: inspectHostConfig{
			NetworkMode: "ao-cloud-test_default",
			Memory:      8 << 30,
			NanoCPUs:    4_000_000_000,
		},
	}
}

func managedLabels(namespace, sessionID, orgID, workspace string) map[string]string {
	return map[string]string{
		labelManaged:   "true",
		labelProvider:  sandbox.ProviderDocker,
		labelSessionID: sessionID,
		labelOrgID:     orgID,
		labelNamespace: namespace,
		labelWorkspace: workspace,
	}
}

func decodeJSON(t *testing.T, r *http.Request, destination any) {
	t.Helper()
	if err := json.NewDecoder(r.Body).Decode(destination); err != nil {
		t.Fatal(err)
	}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func TestContainerNamesNeverEmbedSessionText(t *testing.T) {
	sessionID := `session;$(touch /tmp/pwned)?x=1`
	name := containerName("ao-cloud-test", sessionID)
	if strings.Contains(name, sessionID) || strings.ContainsAny(name, `;$()?=/ `) {
		t.Fatalf("container name %q embeds executable or URL syntax", name)
	}
	if _, err := url.ParseQuery("name=" + url.QueryEscape(name)); err != nil {
		t.Fatalf("container name is not safely encodable: %v", err)
	}
}
