package httpapi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Untrivial-ai/ao-cloud/internal/auth"
	"github.com/Untrivial-ai/ao-cloud/internal/domain"
	"github.com/Untrivial-ai/ao-cloud/internal/postgres"
	"github.com/google/uuid"
)

func TestLocalAuthProjectAndSessionFlow(t *testing.T) {
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
	replicaStore, err := postgres.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer replicaStore.Close()
	api := New(Options{
		Store:            store,
		LocalAuthEnabled: true,
		LocalSessionTTL:  time.Hour,
		SandboxProvider:  "docker",
	})
	server := httptest.NewServer(api.Handler())
	defer server.Close()
	replicaAPI := New(Options{
		Store:            replicaStore,
		LocalAuthEnabled: true,
		LocalSessionTTL:  time.Hour,
		SandboxProvider:  "docker",
	})
	replicaServer := httptest.NewServer(replicaAPI.Handler())
	defer replicaServer.Close()

	first := registerUser(t, server.URL, "first")
	second := registerUser(t, server.URL, "second")

	projectBody := map[string]any{
		"displayName":   "API",
		"repositoryUrl": "https://github.com/example/api",
		"defaultBranch": "main",
		"config":        map[string]any{"language": "go"},
	}
	projectResponse := requestJSON(
		t,
		http.MethodPost,
		server.URL+"/api/cloud/v1/orgs/"+first.OrgID+"/projects",
		first.Token,
		"project-create",
		projectBody,
		http.StatusCreated,
	)
	project := objectField(t, projectResponse, "project")
	projectID := stringField(t, project, "id")

	replayed := requestJSON(
		t,
		http.MethodPost,
		server.URL+"/api/cloud/v1/orgs/"+first.OrgID+"/projects",
		first.Token,
		"project-create",
		projectBody,
		http.StatusCreated,
	)
	if got := stringField(t, objectField(t, replayed, "project"), "id"); got != projectID {
		t.Fatalf("replayed project id = %q, want %q", got, projectID)
	}
	secondProjectBody := map[string]any{
		"displayName":   "Web",
		"repositoryUrl": "https://github.com/example/web",
		"defaultBranch": "main",
	}
	requestJSON(
		t,
		http.MethodPost,
		server.URL+"/api/cloud/v1/orgs/"+first.OrgID+"/projects",
		first.Token,
		"project-create-2",
		secondProjectBody,
		http.StatusCreated,
	)
	firstPage := requestJSON(
		t,
		http.MethodGet,
		server.URL+"/api/cloud/v1/orgs/"+first.OrgID+"/projects?limit=1",
		first.Token,
		"",
		nil,
		http.StatusOK,
	)
	page := objectField(t, firstPage, "page")
	cursor := stringField(t, page, "nextCursor")
	secondPage := requestJSON(
		t,
		http.MethodGet,
		server.URL+"/api/cloud/v1/orgs/"+first.OrgID+"/projects?limit=1&cursor="+cursor,
		first.Token,
		"",
		nil,
		http.StatusOK,
	)
	if items, ok := secondPage["items"].([]any); !ok || len(items) != 1 {
		t.Fatalf("second project page items = %#v", secondPage["items"])
	}

	sessionResponse := requestJSON(
		t,
		http.MethodPost,
		server.URL+"/api/cloud/v1/orgs/"+first.OrgID+"/sessions",
		first.Token,
		"session-create",
		map[string]any{
			"projectId":   projectID,
			"kind":        "worker",
			"harness":     "claude-code",
			"displayName": "Implement API",
			"prompt":      "Build the API",
			"mode":        "read-only",
			"deniedCommands": []string{
				"git push --force:*",
			},
		},
		http.StatusCreated,
	)
	session := objectField(t, sessionResponse, "session")
	sessionID := stringField(t, session, "id")
	if status := stringField(t, session, "status"); status != "idle" {
		t.Fatalf("new session status = %q, want idle", status)
	}
	if state := stringField(t, session, "runtimeState"); state != "requested" {
		t.Fatalf("new session runtime state = %q, want requested", state)
	}
	if mode := stringField(t, session, "mode"); mode != "read-only" {
		t.Fatalf("new session mode = %q, want read-only", mode)
	}
	if denied, ok := session["deniedCommands"].([]any); !ok || len(denied) != 1 {
		t.Fatalf("new session denied commands = %#v", session["deniedCommands"])
	}
	initialEvents := requestJSON(
		t,
		http.MethodGet,
		server.URL+"/api/cloud/v1/orgs/"+first.OrgID+"/sessions/"+sessionID+"/chat-events",
		first.Token,
		"",
		nil,
		http.StatusOK,
	)
	if events, ok := initialEvents["events"].([]any); !ok || len(events) != 1 {
		t.Fatalf("initial events = %#v", initialEvents["events"])
	}

	requestJSON(
		t,
		http.MethodGet,
		server.URL+"/api/cloud/v1/orgs/"+first.OrgID+"/sessions/"+sessionID,
		first.Token,
		"",
		nil,
		http.StatusOK,
	)
	forbidden := requestJSON(
		t,
		http.MethodGet,
		server.URL+"/api/cloud/v1/orgs/"+first.OrgID+"/projects",
		second.Token,
		"",
		nil,
		http.StatusForbidden,
	)
	if code := stringField(t, forbidden, "code"); code != "forbidden" {
		t.Fatalf("cross-tenant error code = %q", code)
	}
	requestJSON(
		t,
		http.MethodGet,
		server.URL+"/api/cloud/v1/orgs/"+first.OrgID+"/sessions/"+sessionID+"/chat-events",
		second.Token,
		"",
		nil,
		http.StatusForbidden,
	)

	emptySessionResponse := requestJSON(
		t,
		http.MethodPost,
		server.URL+"/api/cloud/v1/orgs/"+first.OrgID+"/sessions",
		first.Token,
		"empty-session-create",
		map[string]any{
			"projectId":   projectID,
			"kind":        "worker",
			"harness":     "claude-code",
			"displayName": "Empty session",
			"prompt":      "",
		},
		http.StatusCreated,
	)
	emptySessionID := stringField(t, objectField(t, emptySessionResponse, "session"), "id")
	messageBody := map[string]any{"text": "Start now"}
	messageResponse := requestJSON(
		t,
		http.MethodPost,
		server.URL+"/api/cloud/v1/orgs/"+first.OrgID+"/sessions/"+emptySessionID+"/messages",
		first.Token,
		"message-send",
		messageBody,
		http.StatusAccepted,
	)
	message := objectField(t, messageResponse, "event")
	if sequence, ok := message["sequence"].(float64); !ok || sequence != 1 {
		t.Fatalf("message sequence = %#v", message["sequence"])
	}
	replayedMessage := requestJSON(
		t,
		http.MethodPost,
		server.URL+"/api/cloud/v1/orgs/"+first.OrgID+"/sessions/"+emptySessionID+"/messages",
		first.Token,
		"message-send",
		messageBody,
		http.StatusAccepted,
	)
	if objectField(t, replayedMessage, "event")["sequence"] != message["sequence"] {
		t.Fatalf("replayed message = %#v, original = %#v", replayedMessage, messageResponse)
	}
	requestJSON(
		t,
		http.MethodPost,
		server.URL+"/api/cloud/v1/orgs/"+first.OrgID+"/sessions/"+emptySessionID+"/messages",
		first.Token,
		"message-send",
		map[string]any{"text": "Different"},
		http.StatusConflict,
	)
	replayedEvents := requestJSON(
		t,
		http.MethodGet,
		server.URL+"/api/cloud/v1/orgs/"+first.OrgID+"/sessions/"+emptySessionID+"/chat-events?after=0&limit=1",
		first.Token,
		"",
		nil,
		http.StatusOK,
	)
	if events, ok := replayedEvents["events"].([]any); !ok || len(events) != 1 {
		t.Fatalf("replayed events = %#v", replayedEvents["events"])
	}
	streamContext, cancelStream := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancelStream()
	streamRequest, err := http.NewRequestWithContext(
		streamContext,
		http.MethodGet,
		server.URL+"/api/cloud/v1/orgs/"+first.OrgID+"/sessions/"+emptySessionID+"/events?after=0",
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	streamRequest.Header.Set("Authorization", "Bearer "+first.Token)
	streamResponse, err := http.DefaultClient.Do(streamRequest)
	if err != nil {
		t.Fatalf("open event stream: %v", err)
	}
	defer streamResponse.Body.Close()
	if streamResponse.StatusCode != http.StatusOK {
		t.Fatalf("event stream status = %d", streamResponse.StatusCode)
	}
	reader := bufio.NewReader(streamResponse.Body)
	if block := readSSEBlock(t, reader); !strings.Contains(block, "retry: 2000") {
		t.Fatalf("event stream prelude = %q", block)
	}
	if block := readSSEBlock(t, reader); !strings.Contains(block, `"sequence":1`) ||
		!strings.Contains(block, `"text":"Start now"`) {
		t.Fatalf("event stream event = %q", block)
	}
	cancelStream()

	replicaSessionResponse := requestJSON(
		t,
		http.MethodPost,
		server.URL+"/api/cloud/v1/orgs/"+first.OrgID+"/sessions",
		first.Token,
		"replica-session-create",
		map[string]any{
			"projectId":   projectID,
			"kind":        "worker",
			"harness":     "claude-code",
			"displayName": "Replica stream",
			"prompt":      "",
		},
		http.StatusCreated,
	)
	replicaSessionID := stringField(
		t,
		objectField(t, replicaSessionResponse, "session"),
		"id",
	)
	replicaStreamContext, cancelReplicaStream := context.WithTimeout(
		context.Background(),
		4*time.Second,
	)
	replicaStreamRequest, err := http.NewRequestWithContext(
		replicaStreamContext,
		http.MethodGet,
		server.URL+"/api/cloud/v1/orgs/"+first.OrgID+"/sessions/"+replicaSessionID+"/events?after=0",
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	replicaStreamRequest.Header.Set("Authorization", "Bearer "+first.Token)
	replicaStreamResponse, err := http.DefaultClient.Do(replicaStreamRequest)
	if err != nil {
		t.Fatalf("open cross-replica event stream: %v", err)
	}
	replicaReader := bufio.NewReader(replicaStreamResponse.Body)
	if block := readSSEBlock(t, replicaReader); !strings.Contains(block, "retry: 2000") {
		t.Fatalf("cross-replica stream prelude = %q", block)
	}
	requestJSON(
		t,
		http.MethodPost,
		replicaServer.URL+"/api/cloud/v1/orgs/"+first.OrgID+"/sessions/"+replicaSessionID+"/messages",
		first.Token,
		"replica-message-send",
		map[string]any{"text": "Written through replica B"},
		http.StatusAccepted,
	)
	if block := readSSEBlock(t, replicaReader); !strings.Contains(block, `"sequence":1`) ||
		!strings.Contains(block, `"text":"Written through replica B"`) {
		t.Fatalf("cross-replica stream event = %q", block)
	}
	cancelReplicaStream()
	_ = replicaStreamResponse.Body.Close()

	resumed := requestJSON(
		t,
		http.MethodGet,
		replicaServer.URL+"/api/cloud/v1/orgs/"+first.OrgID+"/sessions/"+replicaSessionID+"/chat-events?after=1",
		first.Token,
		"",
		nil,
		http.StatusOK,
	)
	if events, ok := resumed["events"].([]any); !ok || len(events) != 0 {
		t.Fatalf("resumed events = %#v", resumed["events"])
	}
	if nextAfter, ok := resumed["nextAfter"].(float64); !ok || nextAfter != 1 {
		t.Fatalf("resumed nextAfter = %#v", resumed["nextAfter"])
	}
	drainContext, cancelDrain := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancelDrain()
	drainRequest, err := http.NewRequestWithContext(
		drainContext,
		http.MethodGet,
		replicaServer.URL+"/api/cloud/v1/orgs/"+first.OrgID+"/sessions/"+replicaSessionID+"/events",
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	drainRequest.Header.Set("Authorization", "Bearer "+first.Token)
	drainRequest.Header.Set("Last-Event-ID", "1")
	drainResponse, err := http.DefaultClient.Do(drainRequest)
	if err != nil {
		t.Fatalf("open resumable event stream: %v", err)
	}
	defer drainResponse.Body.Close()
	if cacheControl := drainResponse.Header.Get("Cache-Control"); cacheControl != "no-cache, no-transform" {
		t.Fatalf("event stream Cache-Control = %q", cacheControl)
	}
	drainReader := bufio.NewReader(drainResponse.Body)
	if block := readSSEBlock(t, drainReader); !strings.Contains(block, "retry: 2000") {
		t.Fatalf("resumable stream prelude = %q", block)
	}
	replicaAPI.SetDraining(true)
	streamClosed := make(chan error, 1)
	go func() {
		_, err := drainReader.ReadByte()
		streamClosed <- err
	}()
	select {
	case err := <-streamClosed:
		if err == nil {
			t.Fatal("event stream remained readable after draining")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("event stream did not close while replica drained")
	}

	workosServer := httptest.NewServer(New(Options{
		Store: store,
		WorkOS: staticVerifier{principal: domain.Principal{
			Provider:    "workos",
			ExternalID:  "workos_" + strings.ReplaceAll(uuid.NewString(), "-", ""),
			Email:       "workos@example.com",
			DisplayName: "WorkOS User",
		}},
		LocalSessionTTL: time.Hour,
	}).Handler())
	defer workosServer.Close()
	me := requestJSON(
		t,
		http.MethodGet,
		workosServer.URL+"/api/cloud/v1/me",
		"workos-access-token",
		"",
		nil,
		http.StatusOK,
	)
	organizations, ok := me["organizations"].([]any)
	if !ok || len(organizations) != 1 {
		t.Fatalf("WorkOS organizations = %#v", me["organizations"])
	}

	api.SetDraining(true)
	draining := requestJSON(
		t,
		http.MethodGet,
		server.URL+"/readyz",
		"",
		"",
		nil,
		http.StatusServiceUnavailable,
	)
	if code := stringField(t, draining, "code"); code != "draining" {
		t.Fatalf("draining readiness code = %q", code)
	}
}

func readSSEBlock(t *testing.T, reader *bufio.Reader) string {
	t.Helper()
	var block strings.Builder
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("read SSE block: %v", err)
		}
		if line == "\n" {
			return block.String()
		}
		block.WriteString(line)
	}
}

type staticVerifier struct {
	principal domain.Principal
}

func (v staticVerifier) Verify(context.Context, string) (domain.Principal, error) {
	return v.principal, nil
}

type errorVerifier struct {
	err error
}

func (v errorVerifier) Verify(context.Context, string) (domain.Principal, error) {
	return domain.Principal{}, v.err
}

func TestAuthenticationFailureClassification(t *testing.T) {
	tests := []struct {
		name       string
		err        error
		wantStatus int
	}{
		{
			name:       "invalid token",
			err:        auth.ErrInvalidToken,
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "provider unavailable",
			err:        auth.ErrProviderUnavailable,
			wantStatus: http.StatusServiceUnavailable,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := New(Options{WorkOS: errorVerifier{err: test.err}})
			request := httptest.NewRequest(
				http.MethodGet,
				"/api/cloud/v1/me",
				http.NoBody,
			)
			request.Header.Set("Authorization", "Bearer token")
			response := httptest.NewRecorder()
			server.Handler().ServeHTTP(response, request)
			if response.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d", response.Code, test.wantStatus)
			}
		})
	}
}

func TestLocalRegistrationRejectsBcryptOversizedPassword(t *testing.T) {
	server := New(Options{LocalAuthEnabled: true})
	body := `{
		"email":"person@example.com",
		"displayName":"Person",
		"password":"` + strings.Repeat("a", 73) + `",
		"orgSlug":"person-org",
		"orgName":"Person Org"
	}`
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/cloud/v1/auth/local/register",
		strings.NewReader(body),
	)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusUnprocessableEntity)
	}
}

func TestLocalAuthenticationIsRateLimited(t *testing.T) {
	server := New(Options{LocalAuthEnabled: true})
	for attempt := 1; attempt <= 11; attempt++ {
		request := httptest.NewRequest(
			http.MethodPost,
			"/api/cloud/v1/auth/local/login",
			strings.NewReader(`{`),
		)
		response := httptest.NewRecorder()
		server.Handler().ServeHTTP(response, request)
		if attempt <= 10 && response.Code != http.StatusBadRequest {
			t.Fatalf("attempt %d status = %d", attempt, response.Code)
		}
		if attempt == 11 && response.Code != http.StatusTooManyRequests {
			t.Fatalf("attempt %d status = %d, want 429", attempt, response.Code)
		}
	}
}

type registration struct {
	Token string
	OrgID string
}

func registerUser(t *testing.T, baseURL, prefix string) registration {
	t.Helper()
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")
	response := requestJSON(
		t,
		http.MethodPost,
		baseURL+"/api/cloud/v1/auth/local/register",
		"",
		"",
		map[string]any{
			"email":       fmt.Sprintf("%s-%s@example.com", prefix, suffix),
			"displayName": prefix,
			"password":    "correct horse battery staple",
			"orgSlug":     prefix + "-" + suffix,
			"orgName":     prefix + " organization",
		},
		http.StatusCreated,
	)
	organizations, ok := response["organizations"].([]any)
	if !ok || len(organizations) != 1 {
		t.Fatalf("organizations = %#v", response["organizations"])
	}
	org, ok := organizations[0].(map[string]any)
	if !ok {
		t.Fatalf("organization = %#v", organizations[0])
	}
	return registration{
		Token: stringField(t, response, "token"),
		OrgID: stringField(t, org, "id"),
	}
}

func requestJSON(
	t *testing.T,
	method string,
	url string,
	token string,
	idempotencyKey string,
	body any,
	wantStatus int,
) map[string]any {
	t.Helper()
	var encoded []byte
	var err error
	if body != nil {
		encoded, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	request, err := http.NewRequest(method, url, bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	if idempotencyKey != "" {
		request.Header.Set("Idempotency-Key", idempotencyKey)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var result map[string]any
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.StatusCode != wantStatus {
		t.Fatalf("status = %d, want %d; body = %#v", response.StatusCode, wantStatus, result)
	}
	return result
}

func objectField(t *testing.T, value map[string]any, key string) map[string]any {
	t.Helper()
	field, ok := value[key].(map[string]any)
	if !ok {
		t.Fatalf("%s = %#v", key, value[key])
	}
	return field
}

func stringField(t *testing.T, value map[string]any, key string) string {
	t.Helper()
	field, ok := value[key].(string)
	if !ok {
		t.Fatalf("%s = %#v", key, value[key])
	}
	return field
}
