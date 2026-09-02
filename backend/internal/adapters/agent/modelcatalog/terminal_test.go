package modelcatalog

import (
	"context"
	"errors"
	"io"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type scriptedModelStream struct {
	mu       sync.Mutex
	reads    [][]byte
	writes   strings.Builder
	wrote    chan struct{}
	wroteOne sync.Once
	closed   bool
}

type blockingModelStream struct {
	mu        sync.Mutex
	readySent bool
	writes    strings.Builder
	closed    chan struct{}
	closeOnce sync.Once
}

func newBlockingModelStream() *blockingModelStream {
	return &blockingModelStream{closed: make(chan struct{})}
}

func (s *blockingModelStream) Read(buf []byte) (int, error) {
	s.mu.Lock()
	if !s.readySent {
		s.readySent = true
		s.mu.Unlock()
		return copy(buf, []byte("\x1b[1m❯\x1b[0m \n")), nil
	}
	s.mu.Unlock()
	<-s.closed
	return 0, io.EOF
}

func (s *blockingModelStream) Write(buf []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.writes.Write(buf)
}

func (s *blockingModelStream) Resize(uint16, uint16) error { return nil }
func (s *blockingModelStream) Close() error {
	s.closeOnce.Do(func() { close(s.closed) })
	return nil
}

func newScriptedModelStream(initial, afterWrite string) *scriptedModelStream {
	return &scriptedModelStream{reads: [][]byte{[]byte(initial), []byte(afterWrite)}, wrote: make(chan struct{})}
}

func (s *scriptedModelStream) Read(buf []byte) (int, error) {
	s.mu.Lock()
	if len(s.reads) == 0 {
		s.mu.Unlock()
		return 0, io.EOF
	}
	index := 0
	if len(s.reads) == 1 {
		index = 0
	} else if s.writes.Len() == 0 {
		chunk := s.reads[0]
		s.reads = s.reads[1:]
		s.mu.Unlock()
		return copy(buf, chunk), nil
	}
	chunk := s.reads[index]
	s.reads = s.reads[1:]
	s.mu.Unlock()
	return copy(buf, chunk), nil
}

func (s *scriptedModelStream) Write(buf []byte) (int, error) {
	s.mu.Lock()
	n, err := s.writes.Write(buf)
	s.mu.Unlock()
	s.wroteOne.Do(func() { close(s.wrote) })
	return n, err
}

func (s *scriptedModelStream) Resize(uint16, uint16) error { return nil }

func (s *scriptedModelStream) Close() error {
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
	return nil
}

func TestParseTerminalModelMenusRejectDuplicateIDs(t *testing.T) {
	if _, err := parseMuseModelMenu("1. muse-spark  First\n2. muse-spark  Duplicate\n"); err == nil {
		t.Fatal("Muse duplicate model ID was accepted")
	}
}

func TestParseTerminalModelMenuRejectsTrustAndAuthScreens(t *testing.T) {
	for _, output := range []string{
		"Do you trust the files in this folder?\n1. Yes\n2. No\n",
		"Authentication required. Run login to continue.\n",
	} {
		if _, err := parseMuseModelMenu(output); err == nil {
			t.Fatalf("parseMuseModelMenu(%q) succeeded", output)
		}
	}
}

func TestParseMuseModelMenuRequiresExplicitModelIDs(t *testing.T) {
	output := "1. muse-spark  Fast model\n2. muse-pro-2026-08  Most capable\n"
	got, err := parseMuseModelMenu(output)
	if err != nil {
		t.Fatal(err)
	}
	want := []ports.AgentModelInfo{
		{ID: "muse-spark", Label: "muse-spark"},
		{ID: "muse-pro-2026-08", Label: "muse-pro-2026-08"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("models = %#v, want %#v", got, want)
	}
}

func TestParseMuseModelMenuRejectsLabelOnlyRows(t *testing.T) {
	_, err := parseMuseModelMenu("1. Fast model  Good for quick work\n2. Most capable  Best quality\n")
	if err == nil {
		t.Fatal("expected ambiguous Muse menu error")
	}
}

func TestDiscovererReturnsStaticClaudeCatalogWithoutTerminal(t *testing.T) {
	t.Setenv("ANTHROPIC_MODEL", "")
	t.Setenv("HOME", t.TempDir())
	terminalCalled := false
	request := ports.AgentModelDiscoveryRequest{AgentID: "claude-code", Binary: "/bin/claude"}
	discoverer := Discoverer{
		TerminalSpawner: func(context.Context, []string, []string, string, uint16, uint16) (ports.Stream, error) {
			terminalCalled = true
			return nil, errors.New("terminal must not be used")
		},
	}

	got, err := discoverer.Discover(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if terminalCalled {
		t.Fatal("Claude model discovery opened a terminal")
	}
	if got.Source != "catalog" || !got.AllowCustom || got.SelectionMode != ports.ModelSelectionCatalog {
		t.Fatalf("catalog = %#v", got)
	}
	wantModels := map[string]string{
		"sonnet": "Sonnet", "fable": "Fable 5.1", "opus": "Opus", "haiku": "Haiku", "opus[1m]": "Opus (1M context)",
	}
	if len(got.Models) != len(wantModels) {
		t.Fatalf("models = %#v, want %d entries", got.Models, len(wantModels))
	}
	for _, model := range got.Models {
		if label, ok := wantModels[model.ID]; !ok || model.Label != label {
			t.Fatalf("unexpected model %q in %#v", model.ID, got.Models)
		}
		if model.IsDefault {
			t.Fatalf("model %q marked default without a configured model", model.ID)
		}
	}
}

func TestDiscovererAddsConfiguredClaudeModelOutsideStaticCatalog(t *testing.T) {
	t.Setenv("ANTHROPIC_MODEL", "")
	t.Setenv("HOME", t.TempDir())
	request := ports.AgentModelDiscoveryRequest{
		AgentID: "claude-code",
		Env:     map[string]string{"ANTHROPIC_MODEL": "claude-opus-4-5-20251101"},
	}

	got, err := (Discoverer{}).Discover(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Models) != 6 {
		t.Fatalf("models = %#v, want five static models plus configured model", got.Models)
	}
	for _, model := range got.Models {
		if model.ID == "claude-opus-4-5-20251101" {
			if model.Label != model.ID || !model.IsDefault {
				t.Fatalf("configured model = %#v", model)
			}
			return
		}
	}
	t.Fatalf("configured model missing from %#v", got.Models)
}

func TestDiscoverMuseModelsUsesNoSessionLog(t *testing.T) {
	stream := newScriptedModelStream("⟩\n status · muse-spark\n", "1. muse-spark ✓  Fast\n2. muse-pro  Capable\n")
	var gotArgv []string
	spawn := func(_ context.Context, argv, _ []string, _ string, _, _ uint16) (ports.Stream, error) {
		gotArgv = argv
		return stream, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	got, err := discoverTerminalCatalog(ctx, ports.AgentModelDiscoveryRequest{AgentID: "muse", Binary: "/bin/muse"}, spawn)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(gotArgv, []string{"/bin/muse", "--no-session-log"}) {
		t.Fatalf("argv = %q", gotArgv)
	}
	if len(got.Models) != 2 || got.Models[0].ID != "muse-spark" || !got.Models[0].IsDefault {
		t.Fatalf("catalog = %#v", got)
	}
}

func TestDiscoverTerminalModelsNeverWritesIntoTrustPrompt(t *testing.T) {
	stream := newScriptedModelStream("Do you trust the files in this folder?\n1. Yes  Continue\n2. No  Exit\n", "")
	spawn := func(context.Context, []string, []string, string, uint16, uint16) (ports.Stream, error) {
		return stream, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, err := discoverTerminalCatalog(ctx, ports.AgentModelDiscoveryRequest{AgentID: "muse", Binary: "/bin/muse"}, spawn)
	if err == nil {
		t.Fatal("expected trust prompt error")
	}
	if stream.writes.Len() != 0 || !stream.closed {
		t.Fatalf("writes = %q, closed = %v", stream.writes.String(), stream.closed)
	}
}

func TestDiscoverTerminalModelsClosesOnCancellation(t *testing.T) {
	stream := newBlockingModelStream()
	spawn := func(context.Context, []string, []string, string, uint16, uint16) (ports.Stream, error) {
		return stream, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()

	_, err := discoverTerminalCatalog(ctx, ports.AgentModelDiscoveryRequest{AgentID: "muse", Binary: "/bin/muse"}, spawn)
	if err == nil {
		t.Fatal("expected cancellation error")
	}
	select {
	case <-stream.closed:
	default:
		t.Fatal("terminal was not closed after cancellation")
	}
}
