package httpapi

import (
	"net/url"
	"strings"
	"testing"
)

func TestRewriteBrowserHTMLKeepsResourcesInsideTheSessionProxy(t *testing.T) {
	t.Parallel()
	page, err := url.Parse("http://localhost:3000/app/index.html")
	if err != nil {
		t.Fatal(err)
	}
	got := string(rewriteBrowserHTML([]byte(`<!doctype html><html><head></head><body><script src="/assets/app.js"></script><a href="next">Next</a></body></html>`), page, "org-1", "session-1"))
	prefix := browserProxyPrefix("org-1", "session-1", "http://localhost:3000")
	if !strings.Contains(got, `<base href="`+prefix+`app/">`) {
		t.Fatalf("rewritten page did not set the VM proxy base: %s", got)
	}
	if !strings.Contains(got, `src="`+prefix+`assets/app.js"`) {
		t.Fatalf("root resource did not stay in the VM proxy: %s", got)
	}
	if !strings.Contains(got, `href="`+prefix+`app/next"`) {
		t.Fatalf("relative link did not stay in the VM proxy: %s", got)
	}
	if strings.Contains(got, `href=\"`) {
		t.Fatalf("rewritten page retained invalid escaped HTML quotes: %s", got)
	}
}

func TestRewriteBrowserAssetsPreservesTheirVMPaths(t *testing.T) {
	t.Parallel()
	page, err := url.Parse("http://localhost:3000/app/main.js")
	if err != nil {
		t.Fatal(err)
	}
	prefix := browserProxyPrefix("org", "session", "http://localhost:3000")
	stylesheet := string(rewriteBrowserCSS([]byte(`@import "theme.css"; .logo { background: url("/assets/logo.svg") }`), page, "org", "session"))
	if !strings.Contains(stylesheet, `@import "`+prefix+`app/theme.css"`) || !strings.Contains(stylesheet, `url("`+prefix+`assets/logo.svg")`) {
		t.Fatalf("stylesheet was not rewritten for the VM proxy: %s", stylesheet)
	}
	source := string(rewriteBrowserJavaScript([]byte(`import "/@vite/env"; import App from "./App.tsx"; const load = () => import("/src/lazy.tsx");`), page, "org", "session"))
	if !strings.Contains(source, `import "`+prefix+`@vite/env"`) ||
		!strings.Contains(source, `from "`+prefix+`app/App.tsx"`) ||
		!strings.Contains(source, `import("`+prefix+`src/lazy.tsx"`) {
		t.Fatalf("module imports were not rewritten for the VM proxy: %s", source)
	}
}

func TestBrowserProxyURLRoutesExternalOriginsThroughTheVM(t *testing.T) {
	t.Parallel()
	page, err := url.Parse("http://localhost:3000/")
	if err != nil {
		t.Fatal(err)
	}
	got := browserProxyURL("https://example.com/path?x=1", page, "org", "session")
	want := browserProxyPrefix("org", "session", "https://example.com") + "path?x=1"
	if got != want {
		t.Fatalf("browserProxyURL = %q, want %q", got, want)
	}
}
