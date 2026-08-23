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
	"DELETE /api/cloud/v1/github/user":                                                 true,
	"DELETE /api/cloud/v1/orgs/{orgId}/projects/{projectId}":                           true,
	"DELETE /api/cloud/v1/orgs/{orgId}/provider-connections/agents/{provider}":         true,
	"DELETE /api/cloud/v1/worker/children/{sessionId}":                                 true,
	"GET /api/cloud/v1/github/user":                                                    true,
	"GET /api/cloud/v1/github/user/callback":                                           true,
	"GET /api/cloud/v1/orgs/{orgId}/agents":                                            true,
	"GET /api/cloud/v1/orgs/{orgId}/github/installations":                              true,
	"GET /api/cloud/v1/orgs/{orgId}/github/repositories":                               true,
	"GET /api/cloud/v1/orgs/{orgId}/projects":                                          true,
	"GET /api/cloud/v1/orgs/{orgId}/projects/{projectId}":                              true,
	"GET /api/cloud/v1/orgs/{orgId}/provider-connections":                              true,
	"GET /api/cloud/v1/terminal":                                                       true,
	"GET /api/cloud/v1/worker/children":                                                true,
	"GET /api/cloud/v1/worker/credential":                                              true,
	"GET /api/cloud/v1/worker/turns/{turnId}/cancellation":                             true,
	"POST /api/cloud/v1/github/user/authorize":                                         true,
	"POST /api/cloud/v1/orgs/{orgId}/github/installations/start":                       true,
	"POST /api/cloud/v1/orgs/{orgId}/github/installations/{installationId}/disconnect": true,
	"POST /api/cloud/v1/orgs/{orgId}/github/installations/{installationId}/sync":       true,
	"POST /api/cloud/v1/orgs/{orgId}/github/projects":                                  true,
	"POST /api/cloud/v1/orgs/{orgId}/projects":                                         true,
	"POST /api/cloud/v1/orgs/{orgId}/projects/scratch":                                 true,
	"POST /api/cloud/v1/orgs/{orgId}/projects/{projectId}/resume":                      true,
	"POST /api/cloud/v1/orgs/{orgId}/sessions/{sessionId}/terminal-ticket":             true,
	"POST /api/cloud/v1/worker/bootstrap":                                              true,
	"POST /api/cloud/v1/worker/checkout-grant":                                         true,
	"POST /api/cloud/v1/worker/children":                                               true,
	"POST /api/cloud/v1/worker/children/{sessionId}/messages":                          true,
	"POST /api/cloud/v1/worker/events":                                                 true,
	"POST /api/cloud/v1/worker/heartbeat":                                              true,
	"POST /api/cloud/v1/worker/terminals/agent":                                        true,
	"POST /api/cloud/v1/worker/terminals/{terminalId}/exit":                            true,
	"POST /api/cloud/v1/worker/terminals/{terminalId}/output":                          true,
	"POST /api/cloud/v1/worker/transport/claim":                                        true,
	"POST /api/cloud/v1/worker/transport/{requestId}/complete":                         true,
	"POST /api/cloud/v1/worker/transport/{requestId}/fail":                             true,
	"POST /api/cloud/v1/worker/turns/claim":                                            true,
	"POST /api/cloud/v1/worker/turns/{turnId}/complete":                                true,
	"POST /api/cloud/v1/worker/turns/{turnId}/fail":                                    true,
	"PUT /api/cloud/v1/orgs/{orgId}/provider-connections/agents/{provider}":            true,
}

type contractDocument struct {
	Paths      map[string]map[string]yaml.Node `yaml:"paths"`
	Components struct {
		Schemas map[string]contractSchema `yaml:"schemas"`
	} `yaml:"components"`
}

// contractOperation is the handful of fields the well-formedness check needs.
// It is separate from contractDocument because that one keeps operations as raw
// nodes so the route walk does not have to model every OpenAPI keyword.
type contractOperation struct {
	OperationID string               `yaml:"operationId"`
	Responses   map[string]yaml.Node `yaml:"responses"`
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

// TestContractDocumentIsWellFormed catches the structural mistakes that a
// hand-edited 3,000-line YAML document invites and that no other check reports:
// openapi-typescript happily generates from an operation whose responses were
// swallowed by a neighbouring block scalar, and the resulting client compiles.
func TestContractDocumentIsWellFormed(t *testing.T) {
	doc := loadContract(t)
	httpMethods := map[string]bool{
		"get": true, "put": true, "post": true,
		"delete": true, "patch": true, "head": true, "options": true,
	}

	seen := map[string]string{}
	for _, path := range sortedKeys(doc.Paths) {
		for _, method := range sortedKeys(doc.Paths[path]) {
			if !httpMethods[strings.ToLower(method)] {
				continue
			}
			node := doc.Paths[path][method]
			var operation contractOperation
			if err := node.Decode(&operation); err != nil {
				t.Errorf("%s %s: decode operation: %v", strings.ToUpper(method), path, err)
				continue
			}
			if operation.OperationID == "" {
				t.Errorf("%s %s has no operationId — clients generate method names from it", strings.ToUpper(method), path)
				continue
			}
			if previous, duplicate := seen[operation.OperationID]; duplicate {
				t.Errorf("operationId %q is used by both %s and %s %s", operation.OperationID, previous, strings.ToUpper(method), path)
			}
			seen[operation.OperationID] = strings.ToUpper(method) + " " + path
			if len(operation.Responses) == 0 {
				t.Errorf("%s (%s %s) declares no responses", operation.OperationID, strings.ToUpper(method), path)
			}
		}
	}

	assertReferencesResolve(t, doc)
}

// assertReferencesResolve walks every $ref in the document and checks the target
// exists. A dangling $ref generates as `unknown` rather than failing, so a typo
// in a schema name reaches clients as a silently untyped field.
func assertReferencesResolve(t *testing.T, doc contractDocument) {
	t.Helper()
	raw, err := os.ReadFile(filepath.FromSlash(contractPath))
	if err != nil {
		t.Fatalf("read Cloud contract: %v", err)
	}
	var whole map[string]any
	if err := yaml.Unmarshal(raw, &whole); err != nil {
		t.Fatalf("parse Cloud contract: %v", err)
	}
	_ = doc

	unresolved := map[string]bool{}
	var walk func(any)
	walk = func(node any) {
		switch typed := node.(type) {
		case map[string]any:
			for key, value := range typed {
				if key == "$ref" {
					if reference, isString := value.(string); isString && !resolvesInDocument(whole, reference) {
						unresolved[reference] = true
					}
					continue
				}
				walk(value)
			}
		case []any:
			for _, value := range typed {
				walk(value)
			}
		}
	}
	walk(whole)

	for _, reference := range sortedKeys(unresolved) {
		t.Errorf("$ref %s does not resolve — a dangling ref generates as `unknown`", reference)
	}
}

// resolvesInDocument follows a local JSON pointer such as
// "#/components/schemas/Session". External references are out of scope: the
// contract is deliberately a single self-contained file.
func resolvesInDocument(document map[string]any, reference string) bool {
	pointer, found := strings.CutPrefix(reference, "#/")
	if !found {
		return false
	}
	var current any = document
	for _, segment := range strings.Split(pointer, "/") {
		container, isMap := current.(map[string]any)
		if !isMap {
			return false
		}
		next, exists := container[segment]
		if !exists {
			return false
		}
		current = next
	}
	return true
}

// vendorLeakingFields are property names that would put a compute vendor's
// identity, placement, or own identifiers into the contract.
var vendorLeakingFields = []string{
	"provider", "providerSandboxId", "providerId", "vendor",
	"region", "zone", "availabilityZone", "datacenter",
	"host", "hostname", "node", "instanceId", "machineId",
	"workspaceId",
}

// providerNamingSchemas may name a provider, because naming one is the point.
// RedactedProviderConnection is the organization-admin view of a connection the
// operator configured; WorkerCredentialResponse tells a worker which *agent*
// vendor its credential is for. Neither is a user-facing session or project.
var providerNamingSchemas = map[string]bool{
	"RedactedProviderConnection": true,
	"WorkerCredentialResponse":   true,
}

// TestNoVendorIdentityOutsideProviderAdmin enforces the standing rule that
// vendor names never reach a user-facing DTO. Scanning every schema rather than
// a named few means a future DTO cannot reintroduce the leak somewhere this
// test was not told to look.
func TestNoVendorIdentityOutsideProviderAdmin(t *testing.T) {
	doc := loadContract(t)
	for _, name := range sortedKeys(doc.Components.Schemas) {
		if providerNamingSchemas[name] {
			continue
		}
		properties := doc.Components.Schemas[name].Properties
		for _, banned := range vendorLeakingFields {
			if _, leaked := properties[banned]; leaked {
				t.Errorf("%s.%s exposes compute identity or placement; publish an abstract state instead", name, banned)
			}
		}
	}

	// ProviderName enumerates literal vendor names, so only the admin surface
	// may reference it.
	raw, err := os.ReadFile(filepath.FromSlash(contractPath))
	if err != nil {
		t.Fatalf("read Cloud contract: %v", err)
	}
	for _, name := range sortedKeys(doc.Components.Schemas) {
		if providerNamingSchemas[name] {
			continue
		}
		body, found := schemaBody(string(raw), name)
		if found && strings.Contains(body, "ProviderName") {
			t.Errorf("%s references ProviderName, which enumerates real vendor names", name)
		}
	}
}

// productSchemas are the DTOs the app API owns. The Cloud contract covers
// authentication, organization administration, project placement, terminal
// ticket minting and SCM installation; the product contract is the generated
// app OpenAPI at /api/v1. A second definition of a session, its events, its
// pull requests or its workspace here is the duplicate API that was removed —
// and a second user-facing session type is what created the `mode` collision,
// where Cloud meant a permission mode and the app meant chat-versus-TUI.
var productSchemas = []string{
	"Session", "SessionPage", "CreateSessionInput", "SessionActivity",
	"SessionSandbox", "SandboxState", "SessionInterfaceMode",
	"TerminateSessionInput", "RestoreSessionInput", "UpdateProjectInput",
	"ClientEvent", "ClientEventPage", "SessionPullRequests",
	"SessionReviewState", "PullRequestSummary", "WorkspaceEntryPage",
	"WorkspaceDiff", "WorkspaceFile", "Turn",
}

// TestNoDuplicateProductSurface keeps the Cloud contract from growing a second
// copy of the app API.
func TestNoDuplicateProductSurface(t *testing.T) {
	doc := loadContract(t)
	for _, name := range productSchemas {
		if _, present := doc.Components.Schemas[name]; present {
			t.Errorf("schema %s duplicates a DTO the app API owns; the product contract is the generated /api/v1 spec", name)
		}
	}

	// Session product routes likewise. Terminal ticket minting is the one
	// session-scoped Cloud concern: the ticket is a control-plane credential,
	// and a local daemon has no equivalent.
	for _, path := range sortedKeys(doc.Paths) {
		if !strings.Contains(path, "/sessions") {
			continue
		}
		if strings.HasSuffix(path, "/terminal-ticket") {
			continue
		}
		if strings.HasPrefix(path, "/api/cloud/v1/worker/") {
			continue // worker orchestration, not a product route
		}
		t.Errorf("path %s duplicates the app API's session surface", path)
	}
}

// schemaBody returns the YAML text of one component schema, from its key to the
// next sibling key at the same indentation.
func schemaBody(raw, name string) (string, bool) {
	const indent = "\n    "
	marker := indent + name + ":\n"
	start := strings.Index(raw, marker)
	if start < 0 {
		return "", false
	}
	rest := raw[start+len(marker):]
	for offset := 0; ; {
		next := strings.Index(rest[offset:], indent)
		if next < 0 {
			return rest, true
		}
		absolute := offset + next
		after := rest[absolute+len(indent):]
		// A sibling key starts with a non-space character at this indent.
		if after != "" && after[0] != ' ' {
			return rest[:absolute], true
		}
		offset = absolute + 1
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
