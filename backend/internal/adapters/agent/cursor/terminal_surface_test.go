package cursor

import (
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestCursorTerminalSurfaceRecognizesCurrentEmptyComposer(t *testing.T) {
	output := "cursor-retrieval: tracing to '/tmp/cursor.log'\n\n" +
		"  Cursor Agent\n  \x1b[2mv2026.08.11-e8db854\x1b[0m\n\n" +
		"  Hi — what would you like to work on?\n\n" +
		" \x1b[48;2;21;21;21m                                                                             \x1b[49m\n" +
		" \x1b[48;2;21;21;21m \x1b[2m→ \x1b[0;7m\x1b[48;2;21;21;21mA\x1b[0;2m\x1b[48;2;21;21;21mdd a follow-up\x1b[0m\x1b[48;2;21;21;21m                                                           \x1b[49m\n" +
		" \x1b[48;2;21;21;21m                                                                             \x1b[49m\n\n" +
		"  \x1b[2mCursor Grok 4.6 High Fast\x1b[0m \x1b[2m·\x1b[0m \x1b[2m7%\x1b[0m\n" +
		"  \x1b[2m~/project\x1b[0m\n"

	inspector, ok := any(New()).(ports.TerminalSurfaceInspector)
	if !ok {
		t.Fatal("Cursor adapter does not expose terminal surface inspection")
	}
	got := inspector.InspectTerminalSurface(output)
	if got.Work != ports.TerminalSurfaceWorkIdle || got.Composer != ports.TerminalComposerEmpty {
		t.Fatalf("InspectTerminalSurface() = %+v, want idle empty composer", got)
	}
}

func TestCursorTerminalSurfacePreservesDraft(t *testing.T) {
	output := "  Cursor Agent\n\n" +
		"  → keep this unsent draft\n\n" +
		"  Cursor Grok 4.6 High Fast · 7%\n" +
		"  ~/project\n"

	inspector, ok := any(New()).(ports.TerminalSurfaceInspector)
	if !ok {
		t.Fatal("Cursor adapter does not expose terminal surface inspection")
	}
	got := inspector.InspectTerminalSurface(output)
	if got.Work != ports.TerminalSurfaceWorkIdle || got.Composer != ports.TerminalComposerDraft {
		t.Fatalf("InspectTerminalSurface() = %+v, want idle draft composer", got)
	}
}

func TestCursorTerminalSurfaceFindsComposerAboveTallViewportPadding(t *testing.T) {
	output := "  Cursor Agent\n\n" +
		"  AO_HANDOFF_TERMINAL\n\n" +
		"  → Add a follow-up\n\n" +
		"  Composer 2.5 Fast · 7.9%\n" +
		"  ~/project\n" + strings.Repeat("\n", 32)

	got := New().InspectTerminalSurface(output)
	if got.Work != ports.TerminalSurfaceWorkIdle || got.Composer != ports.TerminalComposerEmpty {
		t.Fatalf("InspectTerminalSurface() = %+v, want idle empty composer above viewport padding", got)
	}
}

func TestCursorTerminalSurfaceDoesNotTreatInterruptibleFrameAsIdle(t *testing.T) {
	output := "  Cursor Agent\n\n" +
		"  Working (esc to interrupt)\n" +
		"  → Add a follow-up\n\n" +
		"  Cursor Grok 4.6 High Fast · 7%\n" +
		"  ~/project\n"

	got := New().InspectTerminalSurface(output)
	if got.Work != ports.TerminalSurfaceWorkActive {
		t.Fatalf("InspectTerminalSurface() = %+v, want active work", got)
	}
}
