package credentials

import (
	"go/parser"
	"go/token"
	"reflect"
	"strings"
	"testing"
)

func TestDeliveryServiceHasNoGeneralPlaintextOrDecryptSurface(t *testing.T) {
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
	deliver, ok := typeOfService.MethodByName("DeliverBootstrap")
	if !ok {
		t.Fatal("authorized bootstrap delivery method is missing")
	}
	// receiver, context, verified capability, provider, remote sink: there is
	// deliberately no caller-provided sandbox/runtime/workspace/org argument.
	if deliver.Type.NumIn() != 5 {
		t.Fatalf("DeliverBootstrap accepts an untrusted identifier: %s", deliver.Type)
	}
}

func TestCredentialDeliveryDoesNotUseControlPlaneFilesystem(t *testing.T) {
	files, err := parser.ParseDir(token.NewFileSet(), ".", nil, parser.ImportsOnly)
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files["credentials"].Files {
		for _, imported := range file.Imports {
			path := strings.Trim(imported.Path.Value, `"`)
			if path == "os" || path == "io/ioutil" || path == "path/filepath" || strings.Contains(path, "sandboxruntime") {
				t.Fatalf("credential control plane imports local filesystem/runtime implementation %q", path)
			}
		}
	}
}
