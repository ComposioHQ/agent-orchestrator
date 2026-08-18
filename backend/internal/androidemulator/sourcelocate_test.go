package androidemulator

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// writeFixtureTree builds a small, realistic project tree: a native Android
// XML layout, a React Native component, and noise directories that must be
// excluded (node_modules, .git, build) so the search doesn't waste time or
// produce false positives from vendored/generated code.
func writeFixtureTree(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	files := map[string]string{
		"app/src/main/res/layout/dialog.xml": `<Button
    android:id="@+id/aerr_close"
    android:text="Close app" />`,
		"app/src/main/java/com/example/MainActivity.kt": `
class MainActivity {
    fun onCloseClicked() { /* handles aerr_close */ }
}`,
		"src/components/LoginButton.jsx": `
export function LoginButton() {
  return <Button testID="login_button" onPress={onLogin} />;
}`,
		"node_modules/some-lib/testID.js": `module.exports.login_button = "should never match, vendored";`,
		".git/COMMIT_EDITMSG":             `mentions login_button but must be excluded`,
		"build/generated/Foo.java":        `// login_button generated artifact, must be excluded`,
	}
	for rel, content := range files {
		full := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestFindSourceMatchesAndroidResourceID(t *testing.T) {
	root := writeFixtureTree(t)
	matches, err := FindSource(context.Background(), root, "android:id/aerr_close")
	if err != nil {
		t.Fatalf("FindSource: %v", err)
	}
	// The fixture's MainActivity.kt has a comment mentioning aerr_close too
	// (deliberately -- a comment naming the identifier is a legitimate,
	// useful heuristic hit, not noise to filter out). Both the XML that
	// defines the id and the code that references it by name should surface.
	if len(matches) != 2 {
		t.Fatalf("matches = %d, want 2 (dialog.xml defines it, MainActivity.kt references it in a comment)", len(matches))
	}
	names := []string{filepath.Base(matches[0].Path), filepath.Base(matches[1].Path)}
	if !containsBoth(names, "dialog.xml", "MainActivity.kt") {
		t.Errorf("match paths = %v, want dialog.xml and MainActivity.kt", names)
	}
}

func containsBoth(got []string, a, b string) bool {
	var hasA, hasB bool
	for _, g := range got {
		if g == a {
			hasA = true
		}
		if g == b {
			hasB = true
		}
	}
	return hasA && hasB
}

func TestFindSourceMatchesReactNativeTestID(t *testing.T) {
	root := writeFixtureTree(t)
	matches, err := FindSource(context.Background(), root, "login_button")
	if err != nil {
		t.Fatalf("FindSource: %v", err)
	}
	if len(matches) != 1 {
		t.Fatalf("matches = %d, want 1 (LoginButton.jsx only, node_modules/.git/build excluded)", len(matches))
	}
	if filepath.Base(matches[0].Path) != "LoginButton.jsx" {
		t.Errorf("match path = %q, want LoginButton.jsx", matches[0].Path)
	}
}

func TestFindSourceExcludesVendoredAndGeneratedDirs(t *testing.T) {
	root := writeFixtureTree(t)
	matches, err := FindSource(context.Background(), root, "login_button")
	if err != nil {
		t.Fatalf("FindSource: %v", err)
	}
	for _, m := range matches {
		if filepath.Base(filepath.Dir(m.Path)) == "node_modules" || filepath.Base(filepath.Dir(m.Path)) == "build" {
			t.Errorf("match from an excluded directory: %+v", m)
		}
	}
}

func TestFindSourceNoMatchesReturnsEmptyNotError(t *testing.T) {
	root := writeFixtureTree(t)
	matches, err := FindSource(context.Background(), root, "totally_unrelated_identifier")
	if err != nil {
		t.Fatalf("FindSource: %v", err)
	}
	if len(matches) != 0 {
		t.Errorf("matches = %+v, want none", matches)
	}
}

func TestFindSourceStripsPackagePrefixFromResourceID(t *testing.T) {
	root := writeFixtureTree(t)
	// A resource-id includes the app's package, which never appears
	// literally in source (only the short name does).
	matches, err := FindSource(context.Background(), root, "com.example:id/aerr_close")
	if err != nil {
		t.Fatalf("FindSource: %v", err)
	}
	// Same reasoning as TestFindSourceMatchesAndroidResourceID: the fixture's
	// MainActivity.kt comment mentioning aerr_close is a legitimate hit too.
	if len(matches) != 2 {
		t.Fatalf("matches = %d, want 2", len(matches))
	}
}

func TestFindSourceEmptyIdentifierReturnsNoMatches(t *testing.T) {
	root := writeFixtureTree(t)
	matches, err := FindSource(context.Background(), root, "")
	if err != nil {
		t.Fatalf("FindSource: %v", err)
	}
	if len(matches) != 0 {
		t.Errorf("matches = %+v, want none for an empty identifier", matches)
	}
}
