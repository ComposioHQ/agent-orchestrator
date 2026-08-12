package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
	"github.com/Untrivial-ai/ao-cloud/internal/postgres"
	"github.com/Untrivial-ai/ao-cloud/internal/reconcile"
	"github.com/Untrivial-ai/ao-cloud/internal/sandbox"
	"github.com/Untrivial-ai/ao-cloud/internal/sandboxresolve"
	"github.com/Untrivial-ai/ao-cloud/internal/worker"
	"github.com/jackc/pgx/v5/pgxpool"
)

// recordingProvider stands in for NodeOps so the whole loop — intent, claim,
// provision, bootstrap, heartbeat — can be exercised with no account and no
// network.
type recordingProvider struct {
	mu           sync.Mutex
	environments map[sandbox.ID]sandbox.Environment
	bootstraps   []sandbox.WorkerBootstrap
	created      []sandbox.Spec
	nextID       int
	prefix       string
}

func newRecordingProvider(prefix string) *recordingProvider {
	return &recordingProvider{
		environments: map[sandbox.ID]sandbox.Environment{},
		prefix:       prefix,
	}
}

func (p *recordingProvider) Create(_ context.Context, spec sandbox.Spec) (sandbox.Environment, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.nextID++
	id := sandbox.ID(p.prefix + "-" + spec.SessionID)
	p.created = append(p.created, spec)
	environment := sandbox.Environment{ID: id, Name: spec.Name, State: sandbox.StateRunning}
	p.environments[id] = environment
	return environment, nil
}

func (p *recordingProvider) Get(_ context.Context, id sandbox.ID) (sandbox.Environment, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	environment, ok := p.environments[id]
	if !ok {
		return sandbox.Environment{}, sandbox.ErrNotFound
	}
	return environment, nil
}

func (p *recordingProvider) FindBySession(context.Context, string) (sandbox.Environment, bool, error) {
	return sandbox.Environment{}, false, nil
}

func (p *recordingProvider) Start(context.Context, sandbox.ID) error  { return nil }
func (p *recordingProvider) Stop(context.Context, sandbox.ID) error   { return nil }
func (p *recordingProvider) Pause(context.Context, sandbox.ID) error  { return nil }
func (p *recordingProvider) Resume(context.Context, sandbox.ID) error { return nil }

func (p *recordingProvider) Delete(_ context.Context, id sandbox.ID) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.environments, id)
	return nil
}

func (p *recordingProvider) BootstrapWorker(
	_ context.Context,
	_ sandbox.ID,
	bootstrap sandbox.WorkerBootstrap,
) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.bootstraps = append(p.bootstraps, bootstrap)
	return nil
}

func (p *recordingProvider) lastBootstrapToken(t *testing.T) string {
	t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.bootstraps) == 0 {
		t.Fatal("the reconciler never installed a worker")
	}
	return p.bootstraps[len(p.bootstraps)-1].Environment["AO_WORKER_BOOTSTRAP_TOKEN"]
}

// TestWorkerBootstrapAndHeartbeatLoop drives the full path a real session takes:
// the API records intent, the reconciler provisions and installs a worker, and
// the worker dials back in to reach `running`.
func TestWorkerBootstrapAndHeartbeatLoop(t *testing.T) {
	databaseURL := os.Getenv("AO_CLOUD_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("AO_CLOUD_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	if err := postgres.Migrate(ctx, databaseURL); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	store, err := postgres.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	tokens := worker.NewTokenManager([]byte("0123456789abcdef0123456789abcdef"))
	api := New(Options{
		Store:            store,
		LocalAuthEnabled: true,
		LocalSessionTTL:  time.Hour,
		SandboxProvider:  sandbox.ProviderNodeOps,
		WorkerTokens:     tokens,
		Provisioning: sandbox.ProvisioningDefaults{
			Release: "test-release",
			NodeOps: sandbox.NodeOpsConfig{
				BaseURL:          "https://api.sb.createos.sh",
				APIKey:           "test-key",
				DefaultShape:     "s-4vcpu-8gb",
				DefaultRootFS:    "devbox:1",
				AutoPauseMinutes: 30,
				WorkerTokenTTL:   15 * time.Minute,
			},
		},
	})
	server := httptest.NewServer(api.Handler())
	defer server.Close()

	user := registerUser(t, server.URL, "worker-loop")
	project := objectField(t, requestJSON(
		t, http.MethodPost, server.URL+"/api/cloud/v1/orgs/"+user.OrgID+"/projects",
		user.Token, "worker-loop-project",
		map[string]any{
			"displayName":   "API",
			"repositoryUrl": "https://github.com/example/api",
			"defaultBranch": "main",
		},
		http.StatusCreated,
	), "project")

	sessionResponse := objectField(t, requestJSON(
		t, http.MethodPost, server.URL+"/api/cloud/v1/orgs/"+user.OrgID+"/sessions",
		user.Token, "worker-loop-session",
		map[string]any{
			"projectId":   stringField(t, project, "id"),
			"kind":        "worker",
			"harness":     "claude-code",
			"displayName": "Worker loop",
		},
		http.StatusCreated,
	), "session")
	sessionID := stringField(t, sessionResponse, "id")

	// Only this session's sandbox should be due, so the assertions below are
	// about it and not about rows left over from another test.
	if _, err := pool.Exec(
		ctx,
		`UPDATE ao_sandboxes SET reconcile_after = now() + interval '1 day' WHERE session_id <> $1`,
		sessionID,
	); err != nil {
		t.Fatal(err)
	}

	provider := newRecordingProvider("sbx-loop")
	reconciler := reconcile.New(store, sandboxresolve.New(provider, nil), reconcile.Options{
		PublicURL:    server.URL,
		WorkerBinary: []byte("fake-ao-worker"),
	})

	// One tick: claim the requested sandbox, create it, install the worker.
	if err := reconciler.ReconcileOnce(ctx); err != nil {
		t.Fatalf("ReconcileOnce() error = %v", err)
	}
	if len(provider.created) != 1 {
		t.Fatalf("provider created %d sandboxes, want 1", len(provider.created))
	}
	if got := provider.created[0].Name; got != "ao-"+sessionID {
		t.Errorf("sandbox name = %q, want ao-%s", got, sessionID)
	}

	assertSandboxState(t, pool, sessionID, domain.SandboxObservedBootstrapping)

	bootstrapToken := provider.lastBootstrapToken(t)
	if bootstrapToken == "" {
		t.Fatal("the worker was installed without a bootstrap token")
	}

	// The worker now dials home with the ticket it found in its environment.
	bootstrap := requestJSON(
		t, http.MethodPost, server.URL+"/api/cloud/v1/worker/bootstrap", "", "",
		map[string]any{
			"bootstrapToken": bootstrapToken,
			"version":        "0.1.0",
			"capabilities":   []string{"worker.heartbeat"},
		},
		http.StatusOK,
	)
	workerToken := stringField(t, bootstrap, "workerToken")
	if workerToken == "" {
		t.Fatal("bootstrap returned no worker token")
	}
	launch := objectField(t, bootstrap, "launch")
	if got := stringField(t, launch, "repositoryUrl"); got != "https://github.com/example/api" {
		t.Errorf("launch repositoryUrl = %q, want the project's repository", got)
	}

	// The ticket is single-use: a replay buys nothing.
	requestJSON(
		t, http.MethodPost, server.URL+"/api/cloud/v1/worker/bootstrap", "", "",
		map[string]any{"bootstrapToken": bootstrapToken, "version": "0.1.0"},
		http.StatusUnauthorized,
	)

	// A heartbeat is what actually promotes the sandbox to running.
	heartbeat := workerRequest(
		t, server.URL+"/api/cloud/v1/worker/heartbeat", workerToken,
		map[string]any{"version": "0.1.0", "capabilities": []string{"worker.heartbeat"}},
		http.StatusOK,
	)
	renewed := stringField(t, heartbeat, "workerToken")
	if renewed == "" {
		t.Fatal("heartbeat did not renew the worker token")
	}
	assertSandboxState(t, pool, sessionID, domain.SandboxObservedRunning)

	// Worker events land on the session stream; forged namespaces do not.
	workerRequest(
		t, server.URL+"/api/cloud/v1/worker/events", renewed,
		map[string]any{"type": "worker.ready", "payload": map[string]any{"version": "0.1.0"}},
		http.StatusAccepted,
	)
	workerRequest(
		t, server.URL+"/api/cloud/v1/worker/events", renewed,
		map[string]any{"type": "billing.credit", "payload": map[string]any{}},
		http.StatusBadRequest,
	)

	// An unsigned or absent credential is refused outright.
	workerRequest(
		t, server.URL+"/api/cloud/v1/worker/heartbeat", "aow1.forged.token",
		map[string]any{"version": "0.1.0"}, http.StatusUnauthorized,
	)

	// Replacing the sandbox mints a new epoch, which must retire the old
	// worker even though its token has not expired.
	if _, err := pool.Exec(
		ctx,
		`UPDATE ao_sandboxes SET reconcile_after = now(), worker_last_seen_at = now() - interval '10 minutes'
		WHERE session_id = $1`,
		sessionID,
	); err != nil {
		t.Fatal(err)
	}
	if err := reconciler.ReconcileOnce(ctx); err != nil {
		t.Fatalf("ReconcileOnce() error = %v", err)
	}
	secondToken := provider.lastBootstrapToken(t)
	if secondToken == bootstrapToken {
		t.Fatal("the repaired sandbox reused the consumed bootstrap ticket")
	}
	newBootstrap := requestJSON(
		t, http.MethodPost, server.URL+"/api/cloud/v1/worker/bootstrap", "", "",
		map[string]any{"bootstrapToken": secondToken, "version": "0.1.0"},
		http.StatusOK,
	)
	if stringField(t, newBootstrap, "workerId") == stringField(t, bootstrap, "workerId") {
		t.Fatal("the replacement worker reused the previous identity")
	}
	workerRequest(
		t, server.URL+"/api/cloud/v1/worker/heartbeat", renewed,
		map[string]any{"version": "0.1.0"}, http.StatusUnauthorized,
	)
}

func TestSessionQuotaIsEnforcedAtIntentTime(t *testing.T) {
	databaseURL := os.Getenv("AO_CLOUD_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("AO_CLOUD_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	if err := postgres.Migrate(ctx, databaseURL); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	store, err := postgres.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	api := New(Options{
		Store:            store,
		LocalAuthEnabled: true,
		LocalSessionTTL:  time.Hour,
		SandboxProvider:  "docker",
		MaxSandboxes:     1,
	})
	server := httptest.NewServer(api.Handler())
	defer server.Close()

	user := registerUser(t, server.URL, "quota")
	project := objectField(t, requestJSON(
		t, http.MethodPost, server.URL+"/api/cloud/v1/orgs/"+user.OrgID+"/projects",
		user.Token, "quota-project",
		map[string]any{
			"displayName":   "API",
			"repositoryUrl": "https://github.com/example/api",
			"defaultBranch": "main",
		},
		http.StatusCreated,
	), "project")
	projectID := stringField(t, project, "id")

	body := map[string]any{
		"projectId":   projectID,
		"kind":        "worker",
		"harness":     "claude-code",
		"displayName": "First",
	}
	requestJSON(
		t, http.MethodPost, server.URL+"/api/cloud/v1/orgs/"+user.OrgID+"/sessions",
		user.Token, "quota-session-1", body, http.StatusCreated,
	)
	body["displayName"] = "Second"
	response := requestJSON(
		t, http.MethodPost, server.URL+"/api/cloud/v1/orgs/"+user.OrgID+"/sessions",
		user.Token, "quota-session-2", body, http.StatusConflict,
	)
	if got := response["code"]; got != "SANDBOX_QUOTA_EXCEEDED" {
		t.Fatalf("error code = %v, want SANDBOX_QUOTA_EXCEEDED", got)
	}
}

func assertSandboxState(t *testing.T, pool *pgxpool.Pool, sessionID, want string) {
	t.Helper()
	var observed string
	if err := pool.QueryRow(
		context.Background(),
		`SELECT observed_state FROM ao_sandboxes WHERE session_id = $1`,
		sessionID,
	).Scan(&observed); err != nil {
		t.Fatal(err)
	}
	if observed != want {
		t.Fatalf("observed_state = %q, want %q", observed, want)
	}
}

func workerRequest(
	t *testing.T,
	url, token string,
	body any,
	wantStatus int,
) map[string]any {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	if token != "" {
		request.Header.Set("Authorization", "Worker "+token)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var result map[string]any
	_ = json.NewDecoder(response.Body).Decode(&result)
	if response.StatusCode != wantStatus {
		t.Fatalf("status = %d, want %d; body = %#v", response.StatusCode, wantStatus, result)
	}
	return result
}
