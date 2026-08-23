package credentials

import (
	"go/parser"
	"go/token"
	"reflect"
	"strings"
	"testing"
)

func TestDeliveryServiceHasNoGeneralPlaintextDecryptOrSandboxSurface(t *testing.T) {
	typeOfService := reflect.TypeOf((*DeliveryService)(nil))
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
	files, err := parser.ParseDir(token.NewFileSet(), ".", nil, parser.ImportsOnly)
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files["credentials"].Files {
		for _, imported := range file.Imports {
			name := strings.Trim(imported.Path.Value, `"`)
			if name == "os" || name == "io/ioutil" || name == "path/filepath" || name == "os/exec" ||
				strings.Contains(name, "sandboxruntime") || strings.Contains(name, "cloud/runtime") {
				t.Fatalf("credential control plane imports forbidden local implementation %q", name)
			}
		}
	}
}
