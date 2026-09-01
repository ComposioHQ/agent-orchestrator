package modelcatalog

import (
	"context"
	"io"
	"os"
	"path/filepath"
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

type repaintingModelStream struct {
	mu        sync.Mutex
	readIndex int
	writes    strings.Builder
	wrote     chan struct{}
	wroteOnce sync.Once
	closed    chan struct{}
	closeOnce sync.Once
}

func newBlockingModelStream() *blockingModelStream {
	return &blockingModelStream{closed: make(chan struct{})}
}

func newRepaintingModelStream() *repaintingModelStream {
	return &repaintingModelStream{
		wrote:  make(chan struct{}),
		closed: make(chan struct{}),
	}
}

func (s *repaintingModelStream) Read(buf []byte) (int, error) {
	s.mu.Lock()
	readIndex := s.readIndex
	s.readIndex++
	s.mu.Unlock()

	switch readIndex {
	case 0:
		return copy(buf, []byte("$\n")), nil
	case 1:
		<-s.wrote
		return copy(buf, []byte("1. Default — Default model\n2. Fable — Fable 5\n3. Sonnet — Sonnet 5\nEnter selection [1-3], or Escape to cancel:\n")), nil
	case 2:
		return copy(buf, []byte("1. Default — Default model\n3. Sonnet — Sonnet 5\n")), nil
	default:
		<-s.closed
		return 0, io.EOF
	}
}

func (s *repaintingModelStream) Write(buf []byte) (int, error) {
	s.mu.Lock()
	n, err := s.writes.Write(buf)
	s.mu.Unlock()
	s.wroteOnce.Do(func() { close(s.wrote) })
	return n, err
}

func (s *repaintingModelStream) Resize(uint16, uint16) error { return nil }

func (s *repaintingModelStream) Close() error {
	s.closeOnce.Do(func() { close(s.closed) })
	return nil
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

func environmentValue(env []string, key string) string {
	prefix := key + "="
	for i := len(env) - 1; i >= 0; i-- {
		if strings.HasPrefix(env[i], prefix) {
			return strings.TrimPrefix(env[i], prefix)
		}
	}
	return ""
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

func TestParseClaudeModelMenuUsesAgentOwnedOptions(t *testing.T) {
	output := "\x1b[32m1. Default (recommended)\x1b[0m — Use the default model (currently Opus 5)\r\n" +
		"2. (selected) Opus (1M context) — Opus 5 with 1M context\r\n" +
		"3. Fable — Fable 5\r\n" +
		"4. Sonnet — Sonnet 5\r\n" +
		"5. Sonnet 5 (1M context) — Sonnet 5 for long sessions\r\n" +
		"6. Haiku — Haiku 4.5\r\n" +
		"Enter selection [1-6], or Escape to cancel:\r\n"

	got, err := parseClaudeModelMenu(output)
	if err != nil {
		t.Fatal(err)
	}
	want := []ports.AgentModelInfo{
		{ID: "opus[1m]", Label: "Opus (1M context)", IsDefault: true},
		{ID: "fable", Label: "Fable"},
		{ID: "sonnet", Label: "Sonnet"},
		{ID: "sonnet[1m]", Label: "Sonnet 5 (1M context)"},
		{ID: "haiku", Label: "Haiku"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("models = %#v, want %#v", got, want)
	}
}

func TestParseClaudeModelMenuUsesLatestCompleteRepaint(t *testing.T) {
	output := "1. Default — Default model\n" +
		"2. Opus — Opus 5\n" +
		"3. Sonnet — Sonnet 5\n" +
		"Enter selection [1-3], or Escape to cancel:\n" +
		"1. Default — Default model\n" +
		"2. Fable — Fable 5\n" +
		"3. Haiku — Haiku 4.5\n" +
		"Enter selection [1-3], or Escape to cancel:\n"

	got, err := parseClaudeModelMenu(output)
	if err != nil {
		t.Fatal(err)
	}
	want := []ports.AgentModelInfo{
		{ID: "fable", Label: "Fable"},
		{ID: "haiku", Label: "Haiku"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("models = %#v, want %#v", got, want)
	}
}

func TestParseClaudeModelMenuRejectsIncompleteNumbering(t *testing.T) {
	_, err := parseClaudeModelMenu("1. Default  Default model\n2. Opus  Opus 5\n4. Sonnet  Sonnet 5\n")
	if err == nil {
		t.Fatal("expected incomplete menu error")
	}
}

func TestParseTerminalModelMenusRejectDuplicateIDs(t *testing.T) {
	if _, err := parseClaudeModelMenu("1. Default  Default model\n2. Sonnet  First\n3. Sonnet  Duplicate\n"); err == nil {
		t.Fatal("Claude duplicate alias was accepted")
	}
	if _, err := parseMuseModelMenu("1. muse-spark  First\n2. muse-spark  Duplicate\n"); err == nil {
		t.Fatal("Muse duplicate model ID was accepted")
	}
}

func TestParseTerminalModelMenuRejectsTrustAndAuthScreens(t *testing.T) {
	for _, output := range []string{
		"Do you trust the files in this folder?\n1. Yes\n2. No\n",
		"Authentication required. Run login to continue.\n",
	} {
		if _, err := parseClaudeModelMenu(output); err == nil {
			t.Fatalf("parseClaudeModelMenu(%q) succeeded", output)
		}
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

func TestDiscoverClaudeModelsUsesPrivateTerminalAndClosesIt(t *testing.T) {
	stream := newScriptedModelStream("$\n", "1. Default — Default model\n2. (selected) Fable — Fable 5\n3. Sonnet — Sonnet 5\nEnter selection [1-3], or Escape to cancel:\n")
	var gotArgv, gotEnv []string
	var gotDir string
	spawn := func(_ context.Context, argv, env []string, workingDir string, rows, cols uint16) (ports.Stream, error) {
		gotArgv, gotEnv, gotDir = argv, env, workingDir
		if rows != 40 || cols != 160 {
			t.Fatalf("terminal size = %dx%d, want 40x160", rows, cols)
		}
		return stream, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	got, err := discoverTerminalCatalog(ctx, ports.AgentModelDiscoveryRequest{
		AgentID: "claude-code", Binary: "/bin/claude", WorkingDir: "/work/project",
		Env: map[string]string{"AO_TEST": "yes", "ANTHROPIC_MODEL": "sonnet"},
	}, spawn)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(gotArgv, []string{"/bin/claude", "--ax-screen-reader", "--safe-mode"}) {
		t.Fatalf("argv = %q", gotArgv)
	}
	if gotDir != "/work/project" || !environmentContains(gotEnv, "AO_TEST=yes") {
		t.Fatalf("workingDir = %q, env = %#v", gotDir, gotEnv)
	}
	if stream.writes.String() != "/model\r" || !stream.closed {
		t.Fatalf("writes = %q, closed = %v", stream.writes.String(), stream.closed)
	}
	if len(got.Models) != 2 || got.Models[0].ID != "sonnet" || !got.Models[0].IsDefault || got.Source != "cli" {
		t.Fatalf("catalog = %#v", got)
	}
}

func TestDiscoverClaudeModelsIsolatesSessionStateAndHooks(t *testing.T) {
	stream := newScriptedModelStream("$\n", "1. Default — Default model\n2. Fable — Fable 5\n3. Sonnet — Sonnet 5\nEnter selection [1-3], or Escape to cancel:\n")
	var isolatedConfigDir string
	spawn := func(_ context.Context, argv, env []string, _ string, _, _ uint16) (ports.Stream, error) {
		if !reflect.DeepEqual(argv, []string{"/bin/claude", "--ax-screen-reader", "--safe-mode"}) {
			t.Fatalf("argv = %q", argv)
		}
		isolatedConfigDir = environmentValue(env, "CLAUDE_CONFIG_DIR")
		if isolatedConfigDir == "" || isolatedConfigDir == "/real/claude" {
			t.Fatalf("CLAUDE_CONFIG_DIR = %q, want isolated directory", isolatedConfigDir)
		}
		if err := os.WriteFile(filepath.Join(isolatedConfigDir, "session.jsonl"), []byte("probe"), 0o600); err != nil {
			t.Fatalf("write isolated session fixture: %v", err)
		}
		return stream, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, err := discoverTerminalCatalog(ctx, ports.AgentModelDiscoveryRequest{
		AgentID: "claude-code", Binary: "/bin/claude",
		Env: map[string]string{"CLAUDE_CONFIG_DIR": "/real/claude"},
	}, spawn)
	if err != nil {
		t.Fatal(err)
	}
	if isolatedConfigDir == "" {
		t.Fatal("spawn did not receive an isolated config directory")
	}
	if _, err := os.Stat(isolatedConfigDir); !os.IsNotExist(err) {
		t.Fatalf("isolated config directory still exists: stat err = %v", err)
	}
}

func TestDiscovererRoutesClaudeThroughVisibleModelMenu(t *testing.T) {
	stream := newScriptedModelStream("$\n", "1. Default — Default model\n2. Opus (1M context) — Opus 5\n3. Fable — Fable 5\n4. Sonnet — Sonnet 5\n5. Sonnet 5 (1M context) — Sonnet 5 long\n6. Haiku — Haiku 4.5\nEnter selection [1-6], or Escape to cancel:\n")
	discoverer := Discoverer{TerminalSpawner: func(context.Context, []string, []string, string, uint16, uint16) (ports.Stream, error) {
		return stream, nil
	}}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	got, err := discoverer.Discover(ctx, ports.AgentModelDiscoveryRequest{AgentID: "claude-code", Binary: "/bin/claude"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"opus[1m]", "fable", "sonnet", "sonnet[1m]", "haiku"}
	if len(got.Models) != len(want) {
		t.Fatalf("models = %#v, want IDs %q", got.Models, want)
	}
	wantIDs := make(map[string]bool, len(want))
	for _, id := range want {
		wantIDs[id] = true
	}
	for _, model := range got.Models {
		if !wantIDs[model.ID] {
			t.Fatalf("unexpected model %#v; want IDs %q", model, want)
		}
		delete(wantIDs, model.ID)
	}
	if len(wantIDs) != 0 {
		t.Fatalf("models = %#v, missing IDs %#v", got.Models, wantIDs)
	}
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

func TestDiscoverTerminalModelsKeepsCompleteMenuDuringPartialRepaint(t *testing.T) {
	stream := newRepaintingModelStream()
	spawn := func(context.Context, []string, []string, string, uint16, uint16) (ports.Stream, error) {
		return stream, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	got, err := discoverTerminalCatalog(ctx, ports.AgentModelDiscoveryRequest{
		AgentID: "claude-code", Binary: "/bin/claude",
	}, spawn)
	if err != nil {
		t.Fatal(err)
	}
	want := []ports.AgentModelInfo{
		{ID: "fable", Label: "Fable"},
		{ID: "sonnet", Label: "Sonnet"},
	}
	if !reflect.DeepEqual(got.Models, want) {
		t.Fatalf("models = %#v, want %#v", got.Models, want)
	}
}

func TestDiscoverTerminalModelsNeverWritesIntoTrustPrompt(t *testing.T) {
	stream := newScriptedModelStream("Do you trust the files in this folder?\n1. Yes  Continue\n2. No  Exit\n", "")
	spawn := func(context.Context, []string, []string, string, uint16, uint16) (ports.Stream, error) {
		return stream, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, err := discoverTerminalCatalog(ctx, ports.AgentModelDiscoveryRequest{AgentID: "claude-code", Binary: "/bin/claude"}, spawn)
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

	_, err := discoverTerminalCatalog(ctx, ports.AgentModelDiscoveryRequest{AgentID: "claude-code", Binary: "/bin/claude"}, spawn)
	if err == nil {
		t.Fatal("expected cancellation error")
	}
	select {
	case <-stream.closed:
	default:
		t.Fatal("terminal was not closed after cancellation")
	}
}
