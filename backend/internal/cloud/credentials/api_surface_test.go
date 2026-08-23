package credentials

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestDeliveryServiceHasNoGeneralPlaintextDecryptOrSandboxSurface(t *testing.T) {
	for _, typeOfService := range []reflect.Type{reflect.TypeOf((*DeliveryService)(nil)), reflect.TypeOf((*VaultService)(nil))} {
		for index := 0; index < typeOfService.NumMethod(); index++ {
			method := typeOfService.Method(index)
			name := strings.ToLower(method.Name)
			if strings.Contains(name, "decrypt") || strings.Contains(name, "plaintext") || strings.Contains(name, "open") {
				t.Fatalf("forbidden general plaintext method exported: %s", method.Name)
			}
			for output := 0; output < method.Type.NumOut(); output++ {
				if method.Type.Out(output) == reflect.TypeOf([]byte(nil)) {
					t.Fatalf("method %s returns plaintext-capable []byte", method.Name)
				}
			}
		}
	}
	typeOfService := reflect.TypeOf((*DeliveryService)(nil))
	deliver, ok := typeOfService.MethodByName("Deliver")
	if !ok {
		t.Fatal("Deliver is missing")
	}
	// receiver, context, verified capability, provider, idempotency key, sink.
	// Sandbox/runtime/workspace/org ids are deliberately absent.
	if deliver.Type.NumIn() != 6 {
		t.Fatalf("Deliver accepts an unexpected argument: %s", deliver.Type)
	}
}

func TestDeliveryLookupScopeIsOpaque(t *testing.T) {
	typeOfLookup := reflect.TypeOf(DeliveryLookup{})
	for index := 0; index < typeOfLookup.NumField(); index++ {
		if typeOfLookup.Field(index).IsExported() {
			t.Fatalf("lookup field is caller-constructible: %s", typeOfLookup.Field(index).Name)
		}
	}
	if (DeliveryLookup{}).valid() {
		t.Fatal("zero lookup is valid")
	}
}

func TestCredentialControlPlaneHasNoLocalFilesystemRuntimeOrProcessSecretImports(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") || strings.HasSuffix(entry.Name(), "_test.go") {
			continue
		}
		file, err := parser.ParseFile(token.NewFileSet(), entry.Name(), nil, parser.ImportsOnly)
		if err != nil {
			t.Fatal(err)
		}
		for _, imported := range file.Imports {
			name := strings.Trim(imported.Path.Value, `"`)
			if name == "os" || name == "io/ioutil" || name == "path/filepath" || name == "os/exec" ||
				strings.Contains(name, "sandboxruntime") || strings.Contains(name, "cloud/runtime") {
				t.Fatalf("credential control plane imports forbidden local implementation %q", name)
			}
		}
	}
}

func TestCredentialControlPlaneHasNoSecretBearingStringFieldsOrJSONDecode(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") || strings.HasSuffix(entry.Name(), "_test.go") {
			continue
		}
		file, err := parser.ParseFile(token.NewFileSet(), entry.Name(), nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(file, func(node ast.Node) bool {
			switch value := node.(type) {
			case *ast.Field:
				fieldType, isIdentifier := value.Type.(*ast.Ident)
				if !isIdentifier || fieldType.Name != "string" {
					return true
				}
				for _, name := range value.Names {
					switch strings.ToLower(name.Name) {
					case "accesstoken", "refreshtoken", "oauthtoken", "apikey", "secret":
						t.Errorf("%s materializes secret-bearing immutable string field %s", entry.Name(), name.Name)
					}
				}
			case *ast.CallExpr:
				selector, ok := value.Fun.(*ast.SelectorExpr)
				if !ok {
					return true
				}
				identifier, isIdentifier := selector.X.(*ast.Ident)
				if isIdentifier && identifier.Name == "json" && selector.Sel.Name == "Unmarshal" {
					t.Errorf("%s decodes credential JSON into immutable Go values", entry.Name())
				}
			}
			return true
		})
	}
}
