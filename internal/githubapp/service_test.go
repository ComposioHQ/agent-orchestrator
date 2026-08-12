package githubapp

import (
	"strings"
	"testing"
)

func TestCompletionHTMLUsesBrandedSuccessPage(t *testing.T) {
	t.Parallel()
	html := string((&Service{}).CompletionHTML(true))
	for _, expected := range []string{
		"Agent Orchestrator",
		"https://aoagents.dev/ao-logo.svg",
		"GitHub connected",
		"Close window",
		"window.close()",
	} {
		if !strings.Contains(html, expected) {
			t.Fatalf("completion page does not contain %q", expected)
		}
	}
}

func TestCompletionHTMLUsesFailureStateWithoutAutoClose(t *testing.T) {
	t.Parallel()
	html := string((&Service{}).CompletionHTML(false))
	if !strings.Contains(html, "Connection failed") {
		t.Fatal("failure page does not contain its heading")
	}
	if strings.Contains(html, "window.setTimeout") {
		t.Fatal("failure page closes before the user can read it")
	}
}
