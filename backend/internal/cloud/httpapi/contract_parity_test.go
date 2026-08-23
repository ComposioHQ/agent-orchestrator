package httpapi

import (
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

const sharedSchemaRefPrefix = "../../backend/internal/httpd/apispec/openapi.yaml#/components/schemas/"

func TestCloudContractUsesCanonicalApplicationSchemas(t *testing.T) {
	cloud := loadOpenAPI(t, cloudContractPath(t))
	app := loadOpenAPI(t, appContractPath(t))
	cloudSchemas := objectAt(t, cloud, "components", "schemas")
	appSchemas := objectAt(t, app, "components", "schemas")

	shared := []string{
		"APIError",
		"ListProjectsResponse",
		"ProjectGetResponse",
		"ProjectSummary",
		"ListSessionsResponse",
		"SessionResponse",
		"ControllersSessionView",
		"SpawnSessionRequest",
		"SpawnSessionResponse",
		"SendSessionMessageRequest",
		"SendSessionMessageResponse",
		"ListSessionPRsResponse",
		"ListReviewsResponse",
		"ListWorkspaceFilesResponse",
		"WorkspaceFileResponse",
	}
	for _, name := range shared {
		if _, ok := appSchemas[name]; !ok {
			t.Fatalf("canonical application schema %q is absent", name)
		}
		schema := mapValue(t, cloudSchemas, name)
		if got := stringValue(schema["$ref"]); got != sharedSchemaRefPrefix+name {
			t.Errorf("cloud schema %s ref = %q, want canonical application ref", name, got)
		}
		if len(schema) != 1 {
			t.Errorf("cloud schema %s forks the canonical schema with siblings: %#v", name, schema)
		}
	}
}

func TestCloudContractForbidsRejectedSurfaces(t *testing.T) {
	cloud := loadOpenAPI(t, cloudContractPath(t))
	paths := objectAt(t, cloud, "paths")
	for path := range paths {
		for _, forbidden := range []string{
			"/api/cloud/v1/orgs/{orgId}/projects",
			"/api/cloud/v1/worker/children",
			"/api/cloud/v1/worker/credential",
			"/api/cloud/v1/worker/terminals",
			"/api/cloud/v1/terminal",
		} {
			if strings.HasPrefix(path, forbidden) {
				t.Errorf("forbidden cloud path returned: %s", path)
			}
		}
		if strings.Contains(path, "/scm/") || strings.HasSuffix(path, "/scm") {
			t.Errorf("old SCM path returned: %s", path)
		}
	}

	schemas := objectAt(t, cloud, "components", "schemas")
	for name := range schemas {
		if strings.HasPrefix(name, "App") {
			t.Errorf("duplicate App* product schema returned: %s", name)
		}
		if strings.Contains(strings.ToLower(name), "workercredential") {
			t.Errorf("plaintext worker credential schema returned: %s", name)
		}
	}
}

func TestCloudContractLocksRuledPathsAndSecurity(t *testing.T) {
	cloud := loadOpenAPI(t, cloudContractPath(t))
	paths := objectAt(t, cloud, "paths")
	required := []string{
		"/api/v1/projects",
		"/api/v1/sessions",
		"/api/v1/sessions/{sessionId}/terminal-ticket",
		"/api/cloud/v1/orgs/{orgId}/workspaces",
		"/api/cloud/v1/orgs/{orgId}/workspaces/{operationId}",
		"/api/cloud/v1/worker/status",
		"/api/cloud/v1/worker/sessions/{sessionId}/messages",
		"/api/cloud/v1/worker/sessions/{sessionId}/pull-requests",
		"/api/cloud/v1/worker/sessions/{sessionId}/reviews",
		"/api/cloud/v1/orgs/{orgId}/github/installations/start",
		"/api/cloud/v1/github/installations/callback",
		"/api/cloud/v1/github/webhook",
	}
	for _, path := range required {
		if _, ok := paths[path]; !ok {
			t.Errorf("required cloud contract path is absent: %s", path)
		}
	}

	for path, raw := range paths {
		pathItem := mapValue(t, paths, path)
		parameters, _ := pathItem["parameters"].([]any)
		hasOrgHeader := hasParameterRef(parameters, "#/components/parameters/XAOOrg")
		switch {
		case strings.HasPrefix(path, "/api/v1/"):
			if !hasOrgHeader {
				t.Errorf("hosted application path %s does not declare X-AO-Org", path)
			}
		case strings.HasPrefix(path, "/api/cloud/v1/orgs/{orgId}/"):
			if hasOrgHeader {
				t.Errorf("admin path %s incorrectly accepts X-AO-Org authority", path)
			}
		}
		_ = raw
	}

	for path, raw := range paths {
		if !strings.HasPrefix(path, "/api/cloud/v1/worker/") {
			continue
		}
		item := mapValue(t, paths, path)
		for _, method := range []string{"get", "post", "put", "patch", "delete"} {
			rawOperation, ok := item[method]
			if !ok {
				continue
			}
			operation, ok := rawOperation.(map[string]any)
			if !ok || !hasSecurityScheme(operation["security"], "workerAuth") {
				t.Errorf("%s %s is not explicitly protected by workerAuth", strings.ToUpper(method), path)
			}
		}
		_ = raw
	}
}

func TestCloudContractModelsAsyncPlacementAndSecretlessDeliveries(t *testing.T) {
	cloud := loadOpenAPI(t, cloudContractPath(t))
	paths := objectAt(t, cloud, "paths")
	create := objectAt(t, mapValue(t, paths, "/api/cloud/v1/orgs/{orgId}/workspaces"), "post", "responses")
	if _, ok := create["202"]; !ok {
		t.Fatal("workspace placement creation must return 202 acceptance")
	}

	schemas := objectAt(t, cloud, "components", "schemas")
	state := mapValue(t, schemas, "WorkspacePlacementState")
	wantStates := []string{"failed", "pending", "ready"}
	gotStates := stringSlice(state["enum"])
	sort.Strings(gotStates)
	if strings.Join(gotStates, ",") != strings.Join(wantStates, ",") {
		t.Fatalf("placement states = %v, want %v", gotStates, wantStates)
	}
	operation := mapValue(t, schemas, "WorkspacePlacementOperation")
	required := stringSlice(operation["required"])
	for _, field := range []string{"operationId", "state", "defaultBranch"} {
		if !contains(required, field) {
			t.Errorf("placement operation does not require %s", field)
		}
	}

	for _, name := range []string{
		"WorkerBootstrapInput",
		"WorkerBootstrapGrant",
		"WorkerHeartbeatInput",
		"WorkerStatus",
		"WorkerCheckoutGrantInput",
		"WorkerCheckoutGrant",
	} {
		assertNoSecretProperty(t, name, mapValue(t, schemas, name))
	}
}

func assertNoSecretProperty(t *testing.T, schemaName string, value any) {
	t.Helper()
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			lower := strings.ToLower(key)
			if key != "$ref" && (strings.Contains(lower, "token") || strings.Contains(lower, "credential") || strings.Contains(lower, "password") || strings.Contains(lower, "secret") || strings.Contains(lower, "argv") || strings.Contains(lower, "environment") || strings.Contains(lower, "gitconfig")) {
				t.Errorf("%s contains forbidden secret transport property %q", schemaName, key)
			}
			assertNoSecretProperty(t, schemaName, child)
		}
	case []any:
		for _, child := range typed {
			assertNoSecretProperty(t, schemaName, child)
		}
	}
}

func loadOpenAPI(t *testing.T, path string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := yaml.Unmarshal(data, &document); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	return document
}

func cloudContractPath(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "../../../..", "contracts/cloud/openapi.yaml"))
}

func appContractPath(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "../../httpd/apispec/openapi.yaml"))
}

func objectAt(t *testing.T, root map[string]any, path ...string) map[string]any {
	t.Helper()
	current := root
	for _, part := range path {
		current = mapValue(t, current, part)
	}
	return current
}

func mapValue(t *testing.T, object map[string]any, key string) map[string]any {
	t.Helper()
	value, ok := object[key]
	if !ok {
		t.Fatalf("missing object key %q", key)
	}
	result, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("object key %q has type %T", key, value)
	}
	return result
}

func stringValue(value any) string {
	result, _ := value.(string)
	return result
}

func stringSlice(value any) []string {
	values, _ := value.([]any)
	result := make([]string, 0, len(values))
	for _, value := range values {
		if text, ok := value.(string); ok {
			result = append(result, text)
		}
	}
	return result
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func hasParameterRef(parameters []any, want string) bool {
	for _, raw := range parameters {
		parameter, _ := raw.(map[string]any)
		if stringValue(parameter["$ref"]) == want {
			return true
		}
	}
	return false
}

func hasSecurityScheme(raw any, want string) bool {
	security, _ := raw.([]any)
	for _, item := range security {
		schemes, _ := item.(map[string]any)
		if _, ok := schemes[want]; ok {
			return true
		}
	}
	return false
}
