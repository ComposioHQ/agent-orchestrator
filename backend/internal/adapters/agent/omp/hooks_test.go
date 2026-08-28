package omp

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func TestManagedExtensionEmitsOMPLifecycleHooksAndIgnoresHookFailures(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake ao executable fixture uses a Unix shebang")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is required to execute the OMP extension fixture")
	}

	fixtureDir := t.TempDir()
	modulePath := writeExecutableOMPExtension(t, fixtureDir, ompActivityExtensionSource())
	capturePath := filepath.Join(fixtureDir, "calls.jsonl")
	writeOMPFixtureFile(t, filepath.Join(fixtureDir, "ao"), `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  fs.appendFileSync(process.env.AO_TEST_CAPTURE, JSON.stringify({args: process.argv.slice(2), input}) + "\n");
  process.exit(9);
});
`, 0o755)
	harnessPath := filepath.Join(fixtureDir, "harness.mjs")
	writeOMPFixtureFile(t, harnessPath, `import { pathToFileURL } from "node:url";
const handlers = new Map();
const loaded = await import(pathToFileURL(process.argv[2]).href);
loaded.default({ on(name, handler) { handlers.set(name, handler); } });
const ctx = { sessionManager: { getSessionId() { return "omp-native-123"; } } };
for (const [name, event] of [
  ["session_start", {}],
  ["before_agent_start", { prompt: "fix the status tracker" }],
  ["tool_approval_requested", { toolName: "bash", toolCallId: "tool-7" }],
  ["tool_approval_resolved", { toolName: "bash", toolCallId: "tool-7", approved: true }],
  ["agent_end", { willContinue: true }],
  ["agent_end", { willContinue: false }],
  ["session_shutdown", {}],
]) {
  await handlers.get(name)(event, ctx);
}
`, 0o600)

	cmd := exec.CommandContext(context.Background(), node, harnessPath, modulePath)
	cmd.Env = append(os.Environ(),
		"PATH="+fixtureDir+string(os.PathListSeparator)+os.Getenv("PATH"),
		"AO_TEST_CAPTURE="+capturePath,
	)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("extension harness failed despite hook exit 9: %v\n%s", err, output)
	}

	calls := readOMPHookCalls(t, capturePath)
	wantEvents := []string{
		"session-start",
		"user-prompt-submit",
		"permission-request",
		"permission-resolved",
		"stop",
		"session-end",
	}
	if len(calls) != len(wantEvents) {
		t.Fatalf("hook calls = %#v, want %d", calls, len(wantEvents))
	}
	for i, event := range wantEvents {
		if !reflect.DeepEqual(calls[i].Args, []string{"hooks", "omp", event}) {
			t.Fatalf("call %d args = %#v, want hooks/omp/%s", i, calls[i].Args, event)
		}
		var payload map[string]any
		if err := json.Unmarshal([]byte(strings.TrimSpace(calls[i].Input)), &payload); err != nil {
			t.Fatalf("call %d payload is not JSON: %v", i, err)
		}
		if payload["session_id"] != "omp-native-123" {
			t.Fatalf("call %d session_id = %#v, want omp-native-123", i, payload["session_id"])
		}
	}

	var promptPayload struct {
		Prompt string `json:"prompt"`
	}
	if err := json.Unmarshal([]byte(calls[1].Input), &promptPayload); err != nil {
		t.Fatal(err)
	}
	if promptPayload.Prompt != "fix the status tracker" {
		t.Fatalf("prompt = %q, want exact submitted prompt", promptPayload.Prompt)
	}
	var approvalPayload struct {
		ToolName  string `json:"tool_name"`
		ToolUseID string `json:"tool_use_id"`
		Approved  bool   `json:"approved"`
	}
	if err := json.Unmarshal([]byte(calls[3].Input), &approvalPayload); err != nil {
		t.Fatal(err)
	}
	if approvalPayload.ToolName != "bash" || approvalPayload.ToolUseID != "tool-7" || !approvalPayload.Approved {
		t.Fatalf("approval payload = %#v", approvalPayload)
	}

	// Removing ao from PATH exercises spawnSync's command-not-found result. The
	// extension must still resolve every handler without rejecting the session.
	missingDir := t.TempDir()
	missingCmd := exec.CommandContext(context.Background(), node, harnessPath, modulePath)
	missingCmd.Env = append(envWithoutOMPPath(os.Environ()), "PATH="+missingDir, "AO_TEST_CAPTURE="+capturePath)
	if output, err := missingCmd.CombinedOutput(); err != nil {
		t.Fatalf("extension harness failed with ao missing: %v\n%s", err, output)
	}
}

func TestManagedExtensionIgnoresHookTimeout(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake ao executable fixture uses a Unix shebang")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is required to execute the OMP extension fixture")
	}

	fixtureDir := t.TempDir()
	source := strings.Replace(ompActivityExtensionSource(), "const HOOK_TIMEOUT_MS = 5_000;", "const HOOK_TIMEOUT_MS = 20;", 1)
	modulePath := writeExecutableOMPExtension(t, fixtureDir, source)
	writeOMPFixtureFile(t, filepath.Join(fixtureDir, "ao"), "#!/usr/bin/env sh\nsleep 1\n", 0o755)
	harnessPath := filepath.Join(fixtureDir, "timeout-harness.mjs")
	writeOMPFixtureFile(t, harnessPath, `import { pathToFileURL } from "node:url";
const handlers = new Map();
const loaded = await import(pathToFileURL(process.argv[2]).href);
loaded.default({ on(name, handler) { handlers.set(name, handler); } });
await handlers.get("session_start")({}, { sessionManager: { getSessionId() { return "omp-native-timeout"; } } });
`, 0o600)

	cmd := exec.CommandContext(context.Background(), node, harnessPath, modulePath)
	cmd.Env = append(os.Environ(), "PATH="+fixtureDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("extension harness failed on hook timeout: %v\n%s", err, output)
	}
}

func writeExecutableOMPExtension(t *testing.T, dir, source string) string {
	t.Helper()
	modulePath := filepath.Join(dir, "ao-activity.mjs")
	source = strings.NewReplacer(
		`import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";`+"\n", "",
		`function callHookSync(hookName: string, payload: Record<string, unknown>)`, `function callHookSync(hookName, payload)`,
		`function sessionID(ctx: any): string`, `function sessionID(ctx)`,
		`export default function (omp: ExtensionAPI)`, `export default function (omp)`,
	).Replace(source)
	writeOMPFixtureFile(t, modulePath, source, 0o600)
	return modulePath
}

type ompHookCall struct {
	Args  []string `json:"args"`
	Input string   `json:"input"`
}

func readOMPHookCalls(t *testing.T, path string) []ompHookCall {
	t.Helper()
	file, err := os.Open(path) //nolint:gosec // test-owned fixture
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	var calls []ompHookCall
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		var call ompHookCall
		if err := json.Unmarshal(scanner.Bytes(), &call); err != nil {
			t.Fatal(err)
		}
		calls = append(calls, call)
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	return calls
}

func writeOMPFixtureFile(t *testing.T, path, contents string, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, []byte(contents), mode); err != nil {
		t.Fatal(err)
	}
}

func envWithoutOMPPath(env []string) []string {
	out := make([]string, 0, len(env))
	for _, entry := range env {
		if !strings.HasPrefix(entry, "PATH=") {
			out = append(out, entry)
		}
	}
	return out
}
