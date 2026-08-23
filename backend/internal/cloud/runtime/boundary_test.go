package runtime_test

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

const modulePath = "github.com/aoagents/agent-orchestrator/backend"

// forbiddenImports are the packages that would mean the compute plane holds
// durable state. A sandbox is disposable compute; PostgreSQL in the control
// plane is the only authority for projects, sessions, prompts, PR facts, and
// lifecycle history. If the compute plane could open a database it would
// eventually become a second, divergent product store — which is exactly the
// sandbox-local SQLite architecture the cloud design rules out.
var forbiddenImports = []string{
	"database/sql",
	"github.com/jackc/pgx",
	"github.com/mattn/go-sqlite3",
	"modernc.org/sqlite",
	"github.com/pressly/goose",
	modulePath + "/internal/storage",
	modulePath + "/internal/cloud/postgres",
}

// TestComputePlaneHoldsNoDurableState walks the compute plane's own packages,
// following imports within this module, and fails if any of them can reach a
// database. It is a structural guarantee rather than a convention: the rule is
// easy to break with one convenient import in a store adapter, and impossible
// to notice in review afterwards.
func TestComputePlaneHoldsNoDurableState(t *testing.T) {
	root := moduleRoot(t)
	roots := []string{
		"internal/cloud/runtime",
		"internal/cloud/runtime/daytona",
		"internal/cloud/runtime/sandboxapi",
		"internal/cloud/capability",
	}

	visited := make(map[string]struct{})
	queue := append([]string(nil), roots...)
	for len(queue) > 0 {
		pkg := queue[0]
		queue = queue[1:]
		if _, seen := visited[pkg]; seen {
			continue
		}
		visited[pkg] = struct{}{}

		for _, imported := range packageImports(t, filepath.Join(root, pkg)) {
			for _, forbidden := range forbiddenImports {
				if imported == forbidden || strings.HasPrefix(imported, forbidden+"/") {
					t.Errorf("%s imports %s: the compute plane must hold no durable state", pkg, imported)
				}
			}
			if strings.HasPrefix(imported, modulePath+"/") {
				queue = append(queue, strings.TrimPrefix(imported, modulePath+"/"))
			}
		}
	}
	if len(visited) < len(roots) {
		t.Fatalf("walked %d packages, want at least the %d roots", len(visited), len(roots))
	}
}

// packageImports returns the import paths of a package's non-test files. Test
// files are excluded on purpose: a conformance test for a PostgreSQL adapter
// legitimately imports a driver.
func packageImports(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read %s: %v", dir, err)
	}
	imports := make([]string, 0, 16)
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(token.NewFileSet(), filepath.Join(dir, name), nil, parser.ImportsOnly)
		if err != nil {
			t.Fatalf("parse %s: %v", name, err)
		}
		for _, spec := range file.Imports {
			path, err := strconv.Unquote(spec.Path.Value)
			if err != nil {
				t.Fatalf("import path in %s: %v", name, err)
			}
			imports = append(imports, path)
		}
	}
	return imports
}

// TestTheBoundaryTestCanFail guards the guard: a walker that silently visited
// nothing would pass forever. It confirms the forbidden-import matcher fires
// on a package that really does open a database.
func TestTheBoundaryTestCanFail(t *testing.T) {
	root := moduleRoot(t)
	imports := packageImports(t, filepath.Join(root, "internal/cloud/postgres"))
	matched := false
	for _, imported := range imports {
		for _, forbidden := range forbiddenImports {
			if imported == forbidden || strings.HasPrefix(imported, forbidden+"/") {
				matched = true
			}
		}
	}
	if !matched {
		t.Fatalf("the matcher found nothing forbidden in the control plane's own store package; imports = %v", imports)
	}
}

// moduleRoot walks up from this test's directory to the backend module root.
func moduleRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("could not find the module root")
		}
		dir = parent
	}
}
