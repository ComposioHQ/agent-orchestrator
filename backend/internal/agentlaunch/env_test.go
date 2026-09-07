package agentlaunch

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestSharedInstallKeepsAgentNodeAndCanonicalAO(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shebang selection; Windows has a separate command test")
	}
	t.Setenv("AO_DATA_DIR", t.TempDir())
	shared, agent := filepath.Join(t.TempDir(), "shared install's bin"), t.TempDir()
	if err := os.MkdirAll(shared, 0o700); err != nil {
		t.Fatal(err)
	}
	write := func(path, body string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(body), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	ao := filepath.Join(shared, "ao")
	write(ao, "#!/bin/sh\necho CANONICAL\n")
	write(filepath.Join(shared, "node"), "#!/bin/sh\necho OLD_NODE\n")
	write(filepath.Join(agent, "node"), "#!/bin/sh\necho AGENT_NODE\n")
	write(filepath.Join(agent, "ao"), "#!/bin/sh\necho FOREIGN\n")
	launcher := filepath.Join(agent, "agent")
	write(launcher, "#!/usr/bin/env node\n")
	executable := func() (string, error) { return ao, nil }
	base := agent + string(os.PathListSeparator) + shared + string(os.PathListSeparator) + "/usr/bin:/bin"
	path, err := PinnedPATH(executable, os.Getenv, map[string]string{"PATH": base})
	if err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"PATH": path}
	AugmentRuntimePATHForLaunchBinary(context.Background(), env, []string{launcher}, func(string) (string, error) { return filepath.Join(agent, "node"), nil }, PinnedDir(executable))
	cmd := exec.CommandContext(context.Background(), "/bin/sh", "-c", "ao; exec \"$1\"", "sh", launcher)
	cmd.Env = []string{"PATH=" + env["PATH"]}
	output, err := cmd.CombinedOutput()
	if err != nil || string(output) != "CANONICAL\nAGENT_NODE\n" {
		t.Fatalf("executable selection: %v: %s", err, output)
	}
	if got := strings.Split(env["PATH"], string(os.PathListSeparator))[0]; got == shared {
		t.Fatal("shared install directory still takes priority")
	}
}
