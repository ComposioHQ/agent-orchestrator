package pi

import (
	"strings"
	"testing"
)

func TestPiExtensionOnlyEndsSessionOnQuit(t *testing.T) {
	source := piActivityExtensionSource()
	for _, reason := range []string{"reload", "new", "resume", "fork"} {
		if strings.Contains(source, `event.reason === "`+reason+`"`) {
			t.Fatalf("session shutdown reason %q must not end the AO session", reason)
		}
	}
	if !strings.Contains(source, `event.reason === "quit"`) {
		t.Fatal("extension must end the AO session only for quit")
	}
}

func TestPiExtensionUsesSettledBeforeLegacyAgentEndFallback(t *testing.T) {
	source := piActivityExtensionSource()
	if !strings.Contains(source, "agent_settled") || !strings.Contains(source, "setTimeout") {
		t.Fatal("extension must support settled and a delayed legacy fallback")
	}
}
