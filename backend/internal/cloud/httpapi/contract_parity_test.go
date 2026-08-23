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

func TestCloudContractIsControlPlaneOnly(t *testing.T) {
	cloud := loadCloudOpenAPI(t)
	paths := objectAt(t, cloud, "paths")
	for path := range paths {
		if strings.HasPrefix(path, "/api/v1") {
			t.Errorf("cloud contract contains application path %s", path)
		}
		if strings.Contains(path, "/orgs/{orgId}/projects") {
			t.Errorf("cloud contract contains duplicate application project surface %s", path)
		}
	}
	schemas := objectAt(t, cloud, "components", "schemas")
	for name, schema := range schemas {
		if strings.HasPrefix(name, "App") {
			t.Errorf("cloud contract contains copied App* product schema %s", name)
		}
		if strings.Contains(name, "Project") {
			t.Errorf("cloud contract contains independent product Project schema %s", name)
		}
		if strings.Contains(name, "Session") && !strings.Contains(name, "WorkerSession") {
			t.Errorf("cloud contract contains independent product Session schema %s", name)
		}
		assertNoString(t, name, schema, "backend/internal/httpd/apispec")
	}
}

func TestCloudContractLocksWorkspacePlacementRoutes(t *testing.T) {
	cloud := loadCloudOpenAPI(t)
	paths := objectAt(t, cloud, "paths")
	assertMethods(t, paths, "/api/cloud/v1/orgs/{orgId}/workspaces", "get", "post")
	assertMethods(t, paths, "/api/cloud/v1/orgs/{orgId}/workspaces/{workspaceId}", "delete", "get")
	assertMethods(t, paths, "/api/cloud/v1/orgs/{orgId}/workspaces/{workspaceId}/resume", "post")
	assertMutation(t, paths, "/api/cloud/v1/orgs/{orgId}/workspaces", "post", "202")
	assertMutation(t, paths, "/api/cloud/v1/orgs/{orgId}/workspaces/{workspaceId}", "delete", "202")
	assertMutation(t, paths, "/api/cloud/v1/orgs/{orgId}/workspaces/{workspaceId}/resume", "post", "202")

	schemas := objectAt(t, cloud, "components", "schemas")
	createInput := mapValue(t, schemas, "CreateWorkspacePlacementInput")
	if required := stringSlice(createInput["required"]); len(required) != 0 {
		t.Errorf("CreateWorkspacePlacementInput requires optional fields: %v", required)
	}
	placement := mapValue(t, schemas, "WorkspacePlacement")
	required := stringSlice(placement["required"])
	for _, field := range []string{"id", "orgId", "ownerUserId", "state", "createdAt", "updatedAt"} {
		if !contains(required, field) {
			t.Errorf("WorkspacePlacement does not require %s", field)
		}
	}
	properties := objectAt(t, placement, "properties")
	if _, ok := properties["projectId"]; !ok {
		t.Error("WorkspacePlacement does not expose optional projectId")
	}
	for _, forbidden := range []string{"defaultBranch", "productProjectId"} {
		if _, ok := properties[forbidden]; ok {
			t.Errorf("WorkspacePlacement exposes non-authoritative field %s", forbidden)
		}
	}
	states := stringSlice(mapValue(t, schemas, "WorkspacePlacementState")["enum"])
	sort.Strings(states)
	if got := strings.Join(states, ","); got != "failed,pending,ready" {
		t.Fatalf("workspace states = %s", got)
	}
}

func TestCloudContractLocksFullWorkerSurface(t *testing.T) {
	paths := objectAt(t, loadCloudOpenAPI(t), "paths")
	want := map[string][]string{
		"/api/cloud/v1/worker/status":                              {"get"},
		"/api/cloud/v1/worker/sessions":                            {"get", "post"},
		"/api/cloud/v1/worker/sessions/{sessionId}":                {"delete", "get"},
		"/api/cloud/v1/worker/sessions/{sessionId}/messages":       {"get", "post"},
		"/api/cloud/v1/worker/sessions/{sessionId}/pr/claim":       {"post"},
		"/api/cloud/v1/worker/sessions/{sessionId}/pr":             {"get"},
		"/api/cloud/v1/worker/sessions/{sessionId}/reviews":        {"get"},
		"/api/cloud/v1/worker/sessions/{sessionId}/reviews/submit": {"post"},
		"/api/cloud/v1/worker/bootstrap":                           {"post"},
		"/api/cloud/v1/worker/heartbeat":                           {"post"},
		"/api/cloud/v1/worker/events":                              {"post"},
		"/api/cloud/v1/worker/turns/claim":                         {"post"},
		"/api/cloud/v1/worker/turns/{turnId}/cancellation":         {"get"},
		"/api/cloud/v1/worker/turns/{turnId}/complete":             {"post"},
		"/api/cloud/v1/worker/turns/{turnId}/fail":                 {"post"},
		"/api/cloud/v1/worker/transport/claim":                     {"post"},
		"/api/cloud/v1/worker/transport/{requestId}/complete":      {"post"},
		"/api/cloud/v1/worker/transport/{requestId}/fail":          {"post"},
	}
	for path, methods := range want {
		assertMethods(t, paths, path, methods...)
		item := mapValue(t, paths, path)
		for _, method := range methods {
			operation := mapValue(t, item, method)
			if !hasSecurityScheme(operation["security"], "workerAuth") {
				t.Errorf("%s %s is not protected by workerAuth", strings.ToUpper(method), path)
			}
		}
	}
	for path := range paths {
		for _, forbidden := range []string{"/worker/children", "/worker/credential", "/worker/terminals"} {
			if strings.Contains(path, forbidden) {
				t.Errorf("forbidden worker surface returned: %s", path)
			}
		}
	}
	transport := mapValue(t, objectAt(t, loadCloudOpenAPI(t), "components", "schemas"), "WorkerWorkspaceTransportRequest")
	assertNoString(t, "WorkerWorkspaceTransportRequest", transport, "terminal.")
}

func TestCloudContractLocksSCMVaultAndTerminalRoutes(t *testing.T) {
	cloud := loadCloudOpenAPI(t)
	paths := objectAt(t, cloud, "paths")
	for path, methods := range map[string][]string{
		"/api/cloud/v1/orgs/{orgId}/github/installations/start":                         {"post"},
		"/api/cloud/v1/github/installations/callback":                                   {"get"},
		"/api/cloud/v1/github/webhook":                                                  {"post"},
		"/api/cloud/v1/orgs/{orgId}/github/installations/{installationId}/sync":         {"post"},
		"/api/cloud/v1/orgs/{orgId}/github/installations/{installationId}/disconnect":   {"delete"},
		"/api/cloud/v1/orgs/{orgId}/github/installations/{installationId}/repositories": {"get", "put"},
		"/api/cloud/v1/orgs/{orgId}/provider-connections":                               {"get"},
		"/api/cloud/v1/orgs/{orgId}/provider-connections/agents/{provider}":             {"delete", "put"},
		"/api/cloud/v1/orgs/{orgId}/sessions/{sessionId}/terminal-ticket":               {"post"},
		"/api/cloud/v1/sandbox/terminal-tickets/consume":                                {"post"},
	} {
		assertMethods(t, paths, path, methods...)
	}
	for path := range paths {
		if strings.Contains(path, "/scm/") || strings.Contains(path, "/worker/credential") || strings.Contains(path, "/worker/audit") {
			t.Errorf("forbidden SCM or worker-vault route returned: %s", path)
		}
		if path == "/api/cloud/v1/terminal" || strings.Contains(path, "/worker/terminals") {
			t.Errorf("control-plane terminal relay returned: %s", path)
		}
		if strings.HasSuffix(path, "/callback") && path != "/api/cloud/v1/github/installations/callback" {
			t.Errorf("non-canonical SCM callback returned: %s", path)
		}
	}

	schemas := objectAt(t, cloud, "components", "schemas")
	ticket := mapValue(t, schemas, "TerminalTicket")
	for _, field := range []string{"connectionUrl", "ticket", "scopes", "expiresAt", "protocol"} {
		if !contains(stringSlice(ticket["required"]), field) {
			t.Errorf("TerminalTicket does not require %s", field)
		}
	}
	ticketProperty := mapValue(t, objectAt(t, ticket, "properties"), "ticket")
	if !strings.HasPrefix(stringValue(ticketProperty["pattern"]), "^ao\\.ticket\\.") {
		t.Errorf("terminal ticket pattern = %q", ticketProperty["pattern"])
	}
	protocol := mapValue(t, objectAt(t, ticket, "properties"), "protocol")
	if stringValue(protocol["const"]) != "ao.mux.v1" {
		t.Errorf("terminal protocol = %q", protocol["const"])
	}
}

func TestCloudContractPreservesErrorsTenancyAndSecretlessWorkerDelivery(t *testing.T) {
	cloud := loadCloudOpenAPI(t)
	paths := objectAt(t, cloud, "paths")
	for path := range paths {
		if !strings.HasPrefix(path, "/api/cloud/v1/orgs/{orgId}/") {
			continue
		}
		item := mapValue(t, paths, path)
		parameters, _ := item["parameters"].([]any)
		if !hasParameterRef(parameters, "#/components/parameters/OrgId") {
			t.Errorf("admin path %s does not retain orgId authority", path)
		}
		if hasHeaderParameter(parameters, "X-AO-Org") {
			t.Errorf("admin path %s accepts X-AO-Org as authority", path)
		}
	}
	schemas := objectAt(t, cloud, "components", "schemas")
	errorEnvelope := mapValue(t, schemas, "ErrorEnvelope")
	if !contains(stringSlice(errorEnvelope["required"]), "requestId") {
		t.Error("ErrorEnvelope does not require requestId")
	}
	for _, name := range []string{
		"WorkerBootstrapInput", "WorkerBootstrapGrant", "WorkerHeartbeatInput",
		"WorkerStatus", "WorkerCheckoutGrantInput", "WorkerCheckoutGrant",
	} {
		assertNoSecretProperty(t, name, mapValue(t, schemas, name))
	}
}

func assertMutation(t *testing.T, paths map[string]any, path, method, status string) {
	t.Helper()
	operation := mapValue(t, mapValue(t, paths, path), method)
	if !hasParameterRef(anySlice(operation["parameters"]), "#/components/parameters/IdempotencyKey") {
		t.Errorf("%s %s does not require Idempotency-Key", strings.ToUpper(method), path)
	}
	responses := mapValue(t, operation, "responses")
	if _, ok := responses[status]; !ok {
		t.Errorf("%s %s does not return %s", strings.ToUpper(method), path, status)
	}
}

func assertMethods(t *testing.T, paths map[string]any, path string, methods ...string) {
	t.Helper()
	item := mapValue(t, paths, path)
	got := make([]string, 0)
	for _, method := range []string{"delete", "get", "patch", "post", "put"} {
		if _, ok := item[method]; ok {
			got = append(got, method)
		}
	}
	sort.Strings(methods)
	if strings.Join(got, ",") != strings.Join(methods, ",") {
		t.Errorf("%s methods = %v, want %v", path, got, methods)
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

func assertNoString(t *testing.T, name string, value any, forbidden string) {
	t.Helper()
	switch typed := value.(type) {
	case string:
		if strings.Contains(typed, forbidden) {
			t.Errorf("%s contains forbidden reference %q", name, typed)
		}
	case map[string]any:
		for _, child := range typed {
			assertNoString(t, name, child, forbidden)
		}
	case []any:
		for _, child := range typed {
			assertNoString(t, name, child, forbidden)
		}
	}
}

func loadCloudOpenAPI(t *testing.T) map[string]any {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	path := filepath.Clean(filepath.Join(filepath.Dir(file), "../../../..", "contracts/cloud/openapi.yaml"))
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
	values := anySlice(value)
	result := make([]string, 0, len(values))
	for _, value := range values {
		if text, ok := value.(string); ok {
			result = append(result, text)
		}
	}
	return result
}

func anySlice(value any) []any {
	result, _ := value.([]any)
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

func hasHeaderParameter(parameters []any, want string) bool {
	for _, raw := range parameters {
		parameter, _ := raw.(map[string]any)
		if stringValue(parameter["in"]) == "header" && stringValue(parameter["name"]) == want {
			return true
		}
	}
	return false
}

func hasSecurityScheme(raw any, want string) bool {
	for _, item := range anySlice(raw) {
		schemes, _ := item.(map[string]any)
		if _, ok := schemes[want]; ok {
			return true
		}
	}
	return false
}
