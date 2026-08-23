package httpapi

import (
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	yaml "gopkg.in/yaml.v3"
)

// contractPath is the repository-root Cloud contract. The backend is its own Go
// module and go:embed cannot reach outside it, so the tests read the file by
// relative path instead — which also keeps a single copy of the contract rather
// than a vendored duplicate that could itself drift.
const contractPath = "../../../../contracts/cloud/openapi.yaml"

// contractPrefix is the only path space the Cloud control plane serves as public
// API. Operational routes (/healthz, /readyz) are deliberately outside it and so
// outside the contract.
const contractPrefix = "/api/cloud/v1/"

// stagedOperations are contract operations that no Go handler serves yet. The
// Cloud contract is written ahead of the implementation on purpose (see
// docs/cloud-refactor.md), so an unmounted operation is expected — but only if
// it is listed here. That makes the list the ledger of what is still owed, and
// makes both directions of drift fail:
//
//   - implementing a route without deleting its line here fails, so the ledger
//     cannot quietly overstate what is left to build;
//   - mounting a route that the contract never described fails in
//     TestCloudRoutesMatchContract, so an implementation cannot outrun the
//     contract.
//
// Delete a line the moment its handler is mounted.
var stagedOperations = map[string]bool{
	"GET /api/cloud/v1/github/user":                                                    true,
	"DELETE /api/cloud/v1/github/user":                                                 true,
	"POST /api/cloud/v1/github/user/authorize":                                         true,
	"GET /api/cloud/v1/github/user/callback":                                           true,
	"GET /api/cloud/v1/orgs/{orgId}/agents":                                            true,
	"GET /api/cloud/v1/orgs/{orgId}/projects":                                          true,
	"POST /api/cloud/v1/orgs/{orgId}/projects":                                         true,
	"GET /api/cloud/v1/orgs/{orgId}/projects/{projectId}":                              true,
	"PATCH /api/cloud/v1/orgs/{orgId}/projects/{projectId}":                            true,
	"DELETE /api/cloud/v1/orgs/{orgId}/projects/{projectId}":                           true,
	"POST /api/cloud/v1/orgs/{orgId}/projects/{projectId}/resume":                      true,
	"POST /api/cloud/v1/orgs/{orgId}/projects/scratch":                                 true,
	"GET /api/cloud/v1/orgs/{orgId}/github/installations":                              true,
	"POST /api/cloud/v1/orgs/{orgId}/github/installations/start":                       true,
	"POST /api/cloud/v1/orgs/{orgId}/github/installations/{installationId}/sync":       true,
	"POST /api/cloud/v1/orgs/{orgId}/github/installations/{installationId}/disconnect": true,
	"GET /api/cloud/v1/orgs/{orgId}/github/repositories":                               true,
	"POST /api/cloud/v1/orgs/{orgId}/github/projects":                                  true,
	"GET /api/cloud/v1/orgs/{orgId}/sessions":                                          true,
	"POST /api/cloud/v1/orgs/{orgId}/sessions":                                         true,
	"GET /api/cloud/v1/orgs/{orgId}/sessions/{sessionId}":                              true,
	"DELETE /api/cloud/v1/orgs/{orgId}/sessions/{sessionId}":                           true,
	"POST /api/cloud/v1/orgs/{orgId}/sessions/{sessionId}/terminate":                   true,
	"POST /api/cloud/v1/orgs/{orgId}/sessions/{sessionId}/restore":                     true,
	"GET /api/cloud/v1/orgs/{orgId}/sessions/{sessionId}/activity":                     true,
	"GET /api/cloud/v1/orgs/{orgId}/sessions/{sessionId}/pull-requests":                true,
	"GET /api/cloud/v1/orgs/{orgId}/sessions/{sessionId}/reviews":                      true,
	"POST /api/cloud/v1/orgs/{orgId}/sessions/{sessionId}/messages":                    true,
	"POST /api/cloud/v1/orgs/{orgId}/sessions/{sessionId}/turns/{turnId}/cancel":       true,
	"GET /api/cloud/v1/orgs/{orgId}/sessions/{sessionId}/chat-events":                  true,
	"GET /api/cloud/v1/orgs/{orgId}/sessions/{sessionId}/events":                       true,
	"POST /api/cloud/v1/orgs/{orgId}/sessions/{sessionId}/terminal-ticket":             true,
	"GET /api/cloud/v1/orgs/{orgId}/sessions/{sessionId}/terminal-connection":          true,
	"GET /api/cloud/v1/terminal":                                                       true,
	"GET /api/cloud/v1/orgs/{orgId}/sessions/{sessionId}/workspace/files":              true,
	"GET /api/cloud/v1/orgs/{orgId}/sessions/{sessionId}/workspace/file":               true,
	"PUT /api/cloud/v1/orgs/{orgId}/sessions/{sessionId}/workspace/file":               true,
	"GET /api/cloud/v1/orgs/{orgId}/sessions/{sessionId}/workspace/diff":               true,
	"GET /api/cloud/v1/orgs/{orgId}/provider-connections":                              true,
	"PUT /api/cloud/v1/orgs/{orgId}/provider-connections/agents/{provider}":            true,
	"DELETE /api/cloud/v1/orgs/{orgId}/provider-connections/agents/{provider}":         true,
	"POST /api/cloud/v1/worker/bootstrap":                                              true,
	"POST /api/cloud/v1/worker/heartbeat":                                              true,
	"POST /api/cloud/v1/worker/events":                                                 true,
	"POST /api/cloud/v1/worker/turns/claim":                                            true,
	"GET /api/cloud/v1/worker/turns/{turnId}/cancellation":                             true,
	"POST /api/cloud/v1/worker/turns/{turnId}/complete":                                true,
	"POST /api/cloud/v1/worker/turns/{turnId}/fail":                                    true,
	"GET /api/cloud/v1/worker/credential":                                              true,
	"POST /api/cloud/v1/worker/checkout-grant":                                         true,
	"GET /api/cloud/v1/worker/children":                                                true,
	"POST /api/cloud/v1/worker/children":                                               true,
	"DELETE /api/cloud/v1/worker/children/{sessionId}":                                 true,
	"POST /api/cloud/v1/worker/children/{sessionId}/messages":                          true,
	"POST /api/cloud/v1/worker/transport/claim":                                        true,
	"POST /api/cloud/v1/worker/transport/{requestId}/complete":                         true,
	"POST /api/cloud/v1/worker/transport/{requestId}/fail":                             true,
	"POST /api/cloud/v1/worker/terminals/agent":                                        true,
	"POST /api/cloud/v1/worker/terminals/{terminalId}/output":                          true,
	"POST /api/cloud/v1/worker/terminals/{terminalId}/exit":                            true,
}

type contractDocument struct {
	Paths      map[string]map[string]yaml.Node `yaml:"paths"`
	Components struct {
		Schemas map[string]contractSchema `yaml:"schemas"`
	} `yaml:"components"`
}

type contractSchema struct {
	Required   []string                  `yaml:"required"`
	Properties map[string]map[string]any `yaml:"properties"`
}

func loadContract(t *testing.T) contractDocument {
	t.Helper()
	raw, err := os.ReadFile(filepath.FromSlash(contractPath))
	if err != nil {
		t.Fatalf("read Cloud contract: %v", err)
	}
	var doc contractDocument
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse Cloud contract: %v", err)
	}
	if len(doc.Paths) == 0 {
		t.Fatal("Cloud contract declares no paths — wrong file?")
	}
	return doc
}

// contractOperations flattens the document into "METHOD /path" keys.
func contractOperations(t *testing.T, doc contractDocument) map[string]bool {
	t.Helper()
	methods := map[string]bool{
		"get": true, "put": true, "post": true,
		"delete": true, "patch": true, "head": true, "options": true,
	}
	operations := map[string]bool{}
	for path, item := range doc.Paths {
		for method := range item {
			if !methods[strings.ToLower(method)] {
				continue // "parameters", "summary", and friends are not operations.
			}
			operations[strings.ToUpper(method)+" "+path] = true
		}
	}
	return operations
}

// mountedRoutes walks the real router the server serves, so the test cannot pass
// against a hand-maintained list of what is believed to be mounted.
func mountedRoutes(t *testing.T) map[string]bool {
	t.Helper()
	server := &Server{}
	routes, ok := server.routes().(chi.Routes)
	if !ok {
		t.Fatal("Cloud router is no longer a chi.Routes — update this walk")
	}
	mounted := map[string]bool{}
	err := chi.Walk(routes, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if strings.HasPrefix(route, contractPrefix) {
			mounted[strings.ToUpper(method)+" "+route] = true
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk Cloud routes: %v", err)
	}
	if len(mounted) == 0 {
		t.Fatalf("no %s* routes mounted — router wiring changed?", contractPrefix)
	}
	return mounted
}

// TestCloudRoutesMatchContract holds the mounted Cloud routes and the public
// contract in 1:1 correspondence, allowing for operations that are contracted
// but not yet built (see stagedOperations).
func TestCloudRoutesMatchContract(t *testing.T) {
	operations := contractOperations(t, loadContract(t))
	mounted := mountedRoutes(t)

	for _, route := range sortedKeys(mounted) {
		if !operations[route] {
			t.Errorf("mounted route %s is not described in %s", route, contractPath)
		}
		if stagedOperations[route] {
			t.Errorf("route %s is mounted but still listed in stagedOperations — delete that line", route)
		}
	}

	for _, operation := range sortedKeys(operations) {
		if mounted[operation] || stagedOperations[operation] {
			continue
		}
		t.Errorf("contract operation %s has no mounted handler; add the handler or list it in stagedOperations", operation)
	}

	for _, operation := range sortedKeys(stagedOperations) {
		if !operations[operation] {
			t.Errorf("stagedOperations lists %s, which the contract no longer describes — delete that line", operation)
		}
	}
}

// TestErrorEnvelopeMatchesContract pins the one DTO every single Cloud response
// can return. A rename here breaks every client's error handling at once, which
// is exactly the drift worth failing a build over.
func TestErrorEnvelopeMatchesContract(t *testing.T) {
	doc := loadContract(t)
	assertStructMatchesSchema(t, doc, "ErrorEnvelope", reflect.TypeOf(errorEnvelope{}))

	// The envelope carries no details field yet, while the contract makes it
	// optional. Assert that asymmetry explicitly so adding the field to the
	// contract as *required* would fail here rather than silently ship an
	// envelope no client can rely on.
	if _, hasDetails := doc.Components.Schemas["ErrorEnvelope"].Properties["details"]; !hasDetails {
		t.Error("ErrorEnvelope no longer declares an optional details property")
	}
}

// TestAuthDTOsMatchContract covers every Cloud route that is actually
// implemented today. Each handler's Go struct must carry exactly the JSON field
// names the contract declares — the contract sets additionalProperties: false,
// so an extra Go field is as much a break as a missing one.
func TestAuthDTOsMatchContract(t *testing.T) {
	doc := loadContract(t)
	for _, testCase := range []struct {
		schema string
		value  any
	}{
		{"GoogleIdentityExchange", googleExchangeRequest{}},
		{"RefreshTokenInput", refreshRequest{}},
		{"CurrentUser", currentUser{}},
		{"OrganizationMembership", organizationMembership{}},
		{"CurrentAccount", currentAccount{}},
		{"AOSession", sessionResponse{}},
	} {
		t.Run(testCase.schema, func(t *testing.T) {
			assertStructMatchesSchema(t, doc, testCase.schema, reflect.TypeOf(testCase.value))
		})
	}
}

// assertStructMatchesSchema compares a struct's JSON field names against a
// contract schema's properties, and asserts every property the contract marks
// required exists on the struct.
func assertStructMatchesSchema(t *testing.T, doc contractDocument, name string, structType reflect.Type) {
	t.Helper()
	schema, ok := doc.Components.Schemas[name]
	if !ok {
		t.Fatalf("contract has no %s schema", name)
	}
	fields := jsonFieldNames(t, structType)

	for _, field := range sortedKeys(fields) {
		if _, declared := schema.Properties[field]; !declared {
			t.Errorf("%s.%s is not a property of contract schema %s", structType.Name(), field, name)
		}
	}
	for _, required := range schema.Required {
		if !fields[required] {
			t.Errorf("contract schema %s requires %q, which %s does not marshal", name, required, structType.Name())
		}
	}
}

func jsonFieldNames(t *testing.T, structType reflect.Type) map[string]bool {
	t.Helper()
	if structType.Kind() != reflect.Struct {
		t.Fatalf("%s is not a struct", structType)
	}
	fields := map[string]bool{}
	for i := range structType.NumField() {
		field := structType.Field(i)
		if !field.IsExported() {
			continue
		}
		name, _, _ := strings.Cut(field.Tag.Get("json"), ",")
		if name == "-" {
			continue
		}
		if name == "" {
			name = field.Name
		}
		fields[name] = true
	}
	return fields
}

func sortedKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
