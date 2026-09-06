//go:build windows

package systemexec

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCommandContextWrapsBatchShimWithComSpec(t *testing.T) {
	dir := t.TempDir()
	shim := filepath.Join(dir, "agent tool.cmd")
	if err := os.WriteFile(shim, []byte("@echo off\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ComSpec", `C:\Windows\System32\cmd.exe`)

	cmd, err := commandContext(context.Background(), shim, "--version")
	if err != nil {
		t.Fatal(err)
	}
	if cmd.Path != `C:\Windows\System32\cmd.exe` {
		t.Fatalf("Path = %q, want ComSpec", cmd.Path)
	}
	if cmd.SysProcAttr == nil || !strings.Contains(cmd.SysProcAttr.CmdLine, `"agent tool.cmd" "--version"`) {
		t.Fatalf("CmdLine = %q, want quoted shim and argument", cmd.SysProcAttr.CmdLine)
	}
	configureProcessGroup(cmd)
	if cmd.SysProcAttr.CmdLine == "" {
		t.Fatal("configureProcessGroup discarded the batch command line")
	}
}

func TestMergeWindowsPathAddsRegistryEntriesWithoutDuplicates(t *testing.T) {
	got := mergeWindowsPath(
		`C:\Windows\System32;C:\Users\tester\AppData\Roaming\npm`,
		`C:\Program Files\Git\cmd;C:\WINDOWS\SYSTEM32`,
		`C:\Users\tester\AppData\Local\Microsoft\WinGet\Links`,
	)
	want := strings.Join([]string{
		`C:\Windows\System32`,
		`C:\Users\tester\AppData\Roaming\npm`,
		`C:\Program Files\Git\cmd`,
		`C:\Users\tester\AppData\Local\Microsoft\WinGet\Links`,
	}, ";")
	if got != want {
		t.Fatalf("mergeWindowsPath() = %q, want %q", got, want)
	}
}
