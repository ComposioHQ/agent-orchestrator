package agentlaunch

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestSharedWindowsInstallSelectsOnlyCanonicalAO(t *testing.T) {
	if os.Getenv("AO_TEST_PIN_CHILD") == "1" {
		exe, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		fmt.Println("IDENTITY=" + exe)
		return
	}
	t.Setenv("AO_DATA_DIR", t.TempDir())
	shared, agent := t.TempDir(), t.TempDir()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	binary, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(shared, "ao.exe"), filepath.Join(shared, "node.exe"), filepath.Join(agent, "ao.exe"), filepath.Join(agent, "node.exe")} {
		if err := os.WriteFile(path, binary, 0o700); err != nil {
			t.Fatal(err)
		} //nolint:gosec // executable test fixture
	}
	canonical := filepath.Join(shared, "ao.exe")
	executable := func() (string, error) { return canonical, nil }
	path, err := PinnedPATH(executable, os.Getenv, map[string]string{"PATH": agent + ";" + shared + ";" + os.Getenv("PATH")})
	if err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"PATH": path}
	AugmentRuntimePATHForLaunchBinary(context.Background(), env, []string{filepath.Join(agent, "agent.exe")}, exec.LookPath, PinnedDir(executable))
	cmd := exec.CommandContext(context.Background(), os.Getenv("ComSpec"), "/d", "/c", "call ao -test.run=^TestSharedWindowsInstallSelectsOnlyCanonicalAO$ & node -test.run=^TestSharedWindowsInstallSelectsOnlyCanonicalAO$")
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if !strings.EqualFold(key, "PATH") {
			cmd.Env = append(cmd.Env, entry)
		}
	}
	cmd.Env = append(cmd.Env, "PATH="+env["PATH"], "AO_TEST_PIN_CHILD=1")
	cmd.Dir = t.TempDir()
	output, err := cmd.CombinedOutput()
	if err != nil || !strings.Contains(string(output), "IDENTITY="+canonical) || !strings.Contains(string(output), "IDENTITY="+filepath.Join(agent, "node.exe")) {
		t.Fatalf("executable selection: %v\n%s", err, output)
	}
}
