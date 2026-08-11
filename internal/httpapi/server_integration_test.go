package httpapi

import (
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
	server := httptest.NewServer(New(Options{
		Store:            store,
		LocalAuthEnabled: true,
		LocalSessionTTL:  time.Hour,
	}).Handler())
	defer server.Close()

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
		},
		http.StatusCreated,
	)
	session := objectField(t, sessionResponse, "session")
	sessionID := stringField(t, session, "id")
	if status := stringField(t, session, "status"); status != "idle" {
		t.Fatalf("new session status = %q, want idle", status)
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
