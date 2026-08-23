package httpapi

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	yaml "gopkg.in/yaml.v3"
)

const (
	cloudContractPath = "../../../../contracts/cloud/openapi.yaml"
	appContractPath   = "../../httpd/apispec/openapi.yaml"
)

var sharedContractOperations = []struct {
	path   string
	method string
}{
	{"/api/v1/projects", "get"},
	{"/api/v1/projects/{id}", "get"},
	{"/api/v1/sessions", "get"},
	{"/api/v1/sessions", "post"},
	{"/api/v1/sessions/{sessionId}", "get"},
	{"/api/v1/sessions/{sessionId}/kill", "post"},
	{"/api/v1/sessions/{sessionId}/restore", "post"},
	{"/api/v1/sessions/{sessionId}/send", "post"},
}

// TestSharedAppContractParity locks the hosted client's product routes to the
// daemon's generated /api/v1 contract. The Cloud document carries App-prefixed
// schema names only to avoid colliding with control-plane placement DTOs; after
// removing that namespace and the hosted-only X-AO-Org parameter, the
// operations and schemas must be structurally identical.
func TestSharedAppContractParity(t *testing.T) {
	cloud := loadOpenAPIMap(t, cloudContractPath)
	app := loadOpenAPIMap(t, appContractPath)

	cloudPaths := mapAt(t, cloud, "paths")
	appPaths := mapAt(t, app, "paths")
	for _, operation := range sharedContractOperations {
		t.Run(strings.ToUpper(operation.method)+" "+operation.path, func(t *testing.T) {
			cloudOperation := mapAt(t, mapAt(t, cloudPaths, operation.path), operation.method)
			appOperation := mapAt(t, mapAt(t, appPaths, operation.path), operation.method)

			normalized := normalizeCloudCopy(cloudOperation).(map[string]any)
			deleteOrganizationParameter(t, normalized)
			if operationID, ok := normalized["operationId"].(string); ok {
				normalized["operationId"] = strings.TrimPrefix(operationID, "app")
				if value := normalized["operationId"].(string); value != "" {
					normalized["operationId"] = strings.ToLower(value[:1]) + value[1:]
				}
			}
			if !reflect.DeepEqual(normalized, appOperation) {
				t.Fatalf("Cloud operation drifted from generated app contract\ncloud: %#v\napp:   %#v", normalized, appOperation)
			}
		})
	}

	cloudSchemas := mapAt(t, mapAt(t, cloud, "components"), "schemas")
	appSchemas := mapAt(t, mapAt(t, app, "components"), "schemas")
	for name, schema := range cloudSchemas {
		appName, copied := strings.CutPrefix(name, "App")
		if !copied {
			continue
		}
		appSchema, exists := appSchemas[appName]
		if !exists {
			t.Errorf("Cloud schema %s has no generated app source %s", name, appName)
			continue
		}
		if normalized := normalizeCloudCopy(schema); !reflect.DeepEqual(normalized, appSchema) {
			t.Errorf("Cloud schema %s drifted from generated app schema %s", name, appName)
		}
	}
}

// TestCloudContractIsWellFormed catches contract errors that code generation
// otherwise weakens to unknown types: missing operation metadata, duplicate
// operation IDs, response-less operations, and dangling local references.
func TestCloudContractIsWellFormed(t *testing.T) {
	document := loadOpenAPIMap(t, cloudContractPath)
	paths := mapAt(t, document, "paths")
	httpMethods := map[string]bool{
		"get": true, "put": true, "post": true, "delete": true,
		"patch": true, "head": true, "options": true,
	}
	seenOperationIDs := map[string]string{}
	for path, rawItem := range paths {
		item, ok := rawItem.(map[string]any)
		if !ok {
			t.Errorf("path %s is not an object", path)
			continue
		}
		for method, rawOperation := range item {
			if !httpMethods[strings.ToLower(method)] {
				continue
			}
			operation, ok := rawOperation.(map[string]any)
			if !ok {
				t.Errorf("%s %s is not an object", strings.ToUpper(method), path)
				continue
			}
			operationID, _ := operation["operationId"].(string)
			if operationID == "" {
				t.Errorf("%s %s has no operationId", strings.ToUpper(method), path)
			} else if previous, duplicate := seenOperationIDs[operationID]; duplicate {
				t.Errorf("operationId %q is used by %s and %s %s", operationID, previous, strings.ToUpper(method), path)
			} else {
				seenOperationIDs[operationID] = strings.ToUpper(method) + " " + path
			}
			if responses, ok := operation["responses"].(map[string]any); !ok || len(responses) == 0 {
				t.Errorf("%s %s declares no responses", strings.ToUpper(method), path)
			}
		}
	}

	unresolved := map[string]bool{}
	var walk func(any)
	walk = func(value any) {
		switch typed := value.(type) {
		case map[string]any:
			for key, child := range typed {
				if key == "$ref" {
					if reference, ok := child.(string); ok && !referenceResolves(document, reference) {
						unresolved[reference] = true
					}
					continue
				}
				walk(child)
			}
		case []any:
			for _, child := range typed {
				walk(child)
			}
		}
	}
	walk(document)
	for reference := range unresolved {
		t.Errorf("unresolved contract reference %s", reference)
	}
}

// TestImplementedCloudDTOParity pins the JSON fields of the control plane's
// implemented shared envelope and authentication DTOs to the public contract.
func TestImplementedCloudDTOParity(t *testing.T) {
	document := loadOpenAPIMap(t, cloudContractPath)
	schemas := mapAt(t, mapAt(t, document, "components"), "schemas")
	for _, testCase := range []struct {
		name  string
		value any
	}{
		{"ErrorEnvelope", errorEnvelope{}},
		{"GoogleIdentityExchange", googleExchangeRequest{}},
		{"RefreshTokenInput", refreshRequest{}},
		{"CurrentUser", currentUser{}},
		{"OrganizationMembership", organizationMembership{}},
		{"CurrentAccount", currentAccount{}},
		{"AOSession", sessionResponse{}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			assertStructSchemaParity(t, testCase.name, schemas, reflect.TypeOf(testCase.value))
		})
	}
}

func loadOpenAPIMap(t *testing.T, path string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.FromSlash(path))
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var document map[string]any
	if err := yaml.Unmarshal(raw, &document); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	return document
}

func mapAt(t *testing.T, parent map[string]any, key string) map[string]any {
	t.Helper()
	value, ok := parent[key].(map[string]any)
	if !ok {
		t.Fatalf("%q is not an object", key)
	}
	return value
}

func deleteOrganizationParameter(t *testing.T, operation map[string]any) {
	t.Helper()
	parameters, ok := operation["parameters"].([]any)
	if !ok {
		t.Fatal("hosted shared operation has no parameters")
	}
	filtered := make([]any, 0, len(parameters))
	removed := false
	for _, value := range parameters {
		parameter, isMap := value.(map[string]any)
		if isMap && parameter["$ref"] == "#/components/parameters/OrganizationHeader" {
			removed = true
			continue
		}
		filtered = append(filtered, value)
	}
	if !removed {
		t.Error("hosted shared operation is missing OrganizationHeader")
	}
	if len(filtered) == 0 {
		delete(operation, "parameters")
	} else {
		operation["parameters"] = filtered
	}
}

func normalizeCloudCopy(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		copy := make(map[string]any, len(typed))
		for key, child := range typed {
			copy[key] = normalizeCloudCopy(child)
		}
		return copy
	case []any:
		copy := make([]any, len(typed))
		for index, child := range typed {
			copy[index] = normalizeCloudCopy(child)
		}
		return copy
	case string:
		return strings.Replace(typed, "#/components/schemas/App", "#/components/schemas/", 1)
	default:
		return value
	}
}

func referenceResolves(document map[string]any, reference string) bool {
	pointer, ok := strings.CutPrefix(reference, "#/")
	if !ok {
		return false
	}
	var current any = document
	for _, segment := range strings.Split(pointer, "/") {
		container, ok := current.(map[string]any)
		if !ok {
			return false
		}
		current, ok = container[segment]
		if !ok {
			return false
		}
	}
	return true
}

func assertStructSchemaParity(t *testing.T, name string, schemas map[string]any, structType reflect.Type) {
	t.Helper()
	schema := mapAt(t, schemas, name)
	properties := mapAt(t, schema, "properties")
	fields := map[string]bool{}
	for index := range structType.NumField() {
		field := structType.Field(index)
		if !field.IsExported() {
			continue
		}
		jsonName, _, _ := strings.Cut(field.Tag.Get("json"), ",")
		if jsonName == "-" {
			continue
		}
		if jsonName == "" {
			jsonName = field.Name
		}
		fields[jsonName] = true
		if _, declared := properties[jsonName]; !declared {
			t.Errorf("%s.%s is absent from contract schema %s", structType.Name(), jsonName, name)
		}
	}
	required, _ := schema["required"].([]any)
	for _, rawName := range required {
		fieldName, _ := rawName.(string)
		if !fields[fieldName] {
			t.Errorf("contract schema %s requires %q, which %s does not marshal", name, fieldName, structType.Name())
		}
	}
}
