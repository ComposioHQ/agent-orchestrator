package harnesscatalog

import "testing"

func TestCatalogAdvertisesOnlyProvisionableHarnesses(t *testing.T) {
	if got := CSV(); got != "claude-code" {
		t.Fatalf("CSV() = %q, want claude-code", got)
	}
	spec, ok := DetectLaunch([]string{"/home/daytona/bin/ao", "agent-process", "--", "/usr/local/bin/claude"})
	if !ok || spec.ID != "claude-code" {
		t.Fatalf("DetectLaunch() = %#v, %v", spec, ok)
	}
	if _, ok = DetectLaunch([]string{"codex"}); ok {
		t.Fatal("Codex advertised before its cloud integration exists")
	}
}
