package omp

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestOmpExtensionMapsLifecycleEvents(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake ao executable fixture uses a Unix shebang")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is required to execute the OMP extension fixture")
	}

	fixtureDir := t.TempDir()
	modulePath := filepath.Join(fixtureDir, "ao-activity.mjs")
	source := strings.NewReplacer(
		`import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";`+"\n", "",
		`function callHookSync(hookName: string, payload: Record<string, unknown>)`, `function callHookSync(hookName, payload)`,
		`function sessionID(ctx: any): string`, `function sessionID(ctx)`,
		`export default function (pi: ExtensionAPI)`, `export default function (pi)`,
	).Replace(ompActivityExtensionSource())
	if err := os.WriteFile(modulePath, []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	capturePath := filepath.Join(fixtureDir, "calls.jsonl")
	if err := os.WriteFile(filepath.Join(fixtureDir, "ao"), []byte(`#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  fs.appendFileSync(process.env.AO_TEST_CAPTURE, JSON.stringify({args: process.argv.slice(2), source: process.env.OMP_EVENT_SOURCE, input}) + "\n");
});
`), 0o755); err != nil {
		t.Fatal(err)
	}
	harnessPath := filepath.Join(fixtureDir, "harness.mjs")
	if err := os.WriteFile(harnessPath, []byte(`import { pathToFileURL } from "node:url";
const handlers = new Map();
const loaded = await import(pathToFileURL(process.argv[2]).href);
loaded.default({ on(name, handler) { handlers.set(name, handler); } });
const ctx = { sessionManager: { getSessionId() { return "omp-session-1"; } } };
process.env.OMP_EVENT_SOURCE = "session_start";
await handlers.get("session_start")({}, ctx);
process.env.OMP_EVENT_SOURCE = "before_agent_start";
await handlers.get("before_agent_start")({ prompt: "fix bug" }, ctx);
process.env.OMP_EVENT_SOURCE = "session_stop";
await handlers.get("session_stop")({}, ctx);
process.env.OMP_EVENT_SOURCE = "session_shutdown";
await handlers.get("session_shutdown")({}, ctx);
`), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.CommandContext(context.Background(), node, harnessPath, modulePath)
	cmd.Env = append(os.Environ(), "PATH="+fixtureDir+string(os.PathListSeparator)+os.Getenv("PATH"), "AO_TEST_CAPTURE="+capturePath)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("OMP extension harness failed: %v\n%s", err, output)
	}
	data, err := os.ReadFile(capturePath)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if got := strings.Count(text, `["hooks","omp","stop"]`); got != 1 {
		t.Fatalf("stop hook count = %d, want 1:\n%s", got, text)
	}
	if !strings.Contains(text, `"source":"session_stop"`) {
		t.Fatalf("stop hook did not come from session_stop:\n%s", text)
	}
	if !strings.Contains(text, `["hooks","omp","session-start"]`) || !strings.Contains(text, `["hooks","omp","user-prompt-submit"]`) || !strings.Contains(text, `["hooks","omp","session-end"]`) {
		t.Fatalf("expected lifecycle hook calls missing:\n%s", text)
	}
	if !strings.Contains(text, `fix bug`) {
		t.Fatalf("user-prompt-submit payload missing prompt:\n%s", text)
	}
}
