package worker

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

type recordingGitRunner struct {
	origin          string
	commands        [][]string
	credentialCalls int
	askpassBodies   []string
}

func (r *recordingGitRunner) Run(
	_ context.Context, directory string, environment map[string]string, arguments ...string,
) (string, error) {
	r.commands = append(r.commands, slices.Clone(arguments))
	if environment["AO_GIT_TOKEN"] != "" {
		r.credentialCalls++
		body, err := os.ReadFile(environment["GIT_ASKPASS"])
		if err != nil {
			return "", err
		}
		r.askpassBodies = append(r.askpassBodies, string(body))
	}
	if arguments[0] == "clone" {
		if err := os.MkdirAll(filepath.Join(arguments[len(arguments)-1], ".git"), 0o700); err != nil {
			return "", err
		}
	}
	if arguments[0] == "init" {
		if err := os.MkdirAll(filepath.Join(directory, ".git"), 0o700); err != nil {
			return "", err
		}
	}
	if arguments[0] == "remote" {
		return r.origin + "\n", nil
	}
	return "", nil
}

func TestPrepareCheckoutClonesWithoutPersistingCredential(t *testing.T) {
	token := "github-secret-installation-token"
	workspace := filepath.Join(t.TempDir(), "repository")
	runner := &recordingGitRunner{origin: "https://github.com/acme/api.git"}
	err := PrepareCheckout(context.Background(), runner, workspace, CheckoutGrantResponse{
		CloneURL: "https://github.com/acme/api.git", Token: token,
		ExpiresAt: time.Now().Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if runner.credentialCalls != 1 || len(runner.commands) != 2 ||
		runner.commands[0][0] != "clone" || runner.commands[1][0] != "remote" {
		t.Fatalf("commands = %#v, credential calls = %d", runner.commands, runner.credentialCalls)
	}
	for _, command := range runner.commands {
		if strings.Contains(strings.Join(command, "\x00"), token) {
			t.Fatal("installation token entered git argv")
		}
	}
	for _, body := range runner.askpassBodies {
		if strings.Contains(body, token) {
			t.Fatal("installation token was written into askpass")
		}
	}
	if raw, err := os.ReadFile(filepath.Join(workspace, ".git", "config")); err == nil &&
		strings.Contains(string(raw), token) {
		t.Fatal("installation token entered git config")
	}
}

func TestPrepareCheckoutAllowsAnonymousPublicGitHubClone(t *testing.T) {
	workspace := filepath.Join(t.TempDir(), "repository")
	if err := os.MkdirAll(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	runner := &recordingGitRunner{origin: "https://github.com/aoagents/cloud-smoke.git"}
	err := PrepareCheckout(context.Background(), runner, workspace, CheckoutGrantResponse{
		CloneURL: "https://github.com/aoagents/cloud-smoke",
	})
	if err != nil {
		t.Fatal(err)
	}
	if runner.credentialCalls != 0 || len(runner.commands) != 2 ||
		runner.commands[0][0] != "clone" || runner.commands[1][0] != "remote" {
		t.Fatalf("commands = %#v, credential calls = %d", runner.commands, runner.credentialCalls)
	}
}

func TestPrepareScratchWorkspaceInitializesAndReusesRepository(t *testing.T) {
	workspace := filepath.Join(t.TempDir(), "workspace")
	runner := &recordingGitRunner{}

	if err := PrepareScratchWorkspace(
		context.Background(), runner, workspace,
	); err != nil {
		t.Fatal(err)
	}
	if len(runner.commands) != 1 || runner.commands[0][0] != "init" {
		t.Fatalf("commands after initialization = %#v", runner.commands)
	}
	if err := os.WriteFile(
		filepath.Join(workspace, "README.md"), []byte("persistent\n"), 0o600,
	); err != nil {
		t.Fatal(err)
	}
	if err := PrepareScratchWorkspace(
		context.Background(), runner, workspace,
	); err != nil {
		t.Fatal(err)
	}
	if len(runner.commands) != 2 || runner.commands[1][0] != "rev-parse" {
		t.Fatalf("commands after reuse = %#v", runner.commands)
	}
}

func TestScratchRepositoryURLUsesReservedLocalHost(t *testing.T) {
	for _, test := range []struct {
		raw  string
		want bool
	}{
		{raw: "https://scratch.ao.local/agent-123", want: true},
		{raw: "https://scratch.ao.local", want: false},
		{raw: "https://scratch.ao.local.evil.example/agent-123", want: false},
		{raw: "https://github.com/acme/repository", want: false},
	} {
		if got := IsScratchRepositoryURL(test.raw); got != test.want {
			t.Errorf("IsScratchRepositoryURL(%q) = %v, want %v", test.raw, got, test.want)
		}
	}
}

func TestPrepareCheckoutValidatesThenFetchesPersistentWorkspace(t *testing.T) {
	workspace := filepath.Join(t.TempDir(), "repository")
	if err := os.MkdirAll(filepath.Join(workspace, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	runner := &recordingGitRunner{origin: "git@github.com:Acme/API.git"}
	err := PrepareCheckout(context.Background(), runner, workspace, CheckoutGrantResponse{
		CloneURL: "https://github.com/acme/api.git", Token: "short-lived",
		ExpiresAt: time.Now().Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(runner.commands) != 2 || runner.commands[0][0] != "remote" ||
		runner.commands[1][0] != "fetch" || runner.credentialCalls != 1 {
		t.Fatalf("commands = %#v, credential calls = %d", runner.commands, runner.credentialCalls)
	}
}

func TestPrepareCheckoutRejectsMismatchedOriginBeforeCredentialUse(t *testing.T) {
	workspace := filepath.Join(t.TempDir(), "repository")
	if err := os.MkdirAll(filepath.Join(workspace, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	runner := &recordingGitRunner{origin: "https://github.com/other/repository.git"}
	err := PrepareCheckout(context.Background(), runner, workspace, CheckoutGrantResponse{
		CloneURL: "https://github.com/acme/api.git", Token: "must-not-be-used",
		ExpiresAt: time.Now().Add(time.Hour),
	})
	if err == nil || !strings.Contains(err.Error(), "does not match") ||
		len(runner.commands) != 1 || runner.credentialCalls != 0 {
		t.Fatalf("error = %v, commands = %#v, credential calls = %d", err, runner.commands, runner.credentialCalls)
	}
}

func TestPushBranchPushesWithoutPersistingCredential(t *testing.T) {
	token := "github-write-secret"
	workspace := filepath.Join(t.TempDir(), "repository")
	if err := os.MkdirAll(filepath.Join(workspace, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	runner := &recordingGitRunner{}
	err := PushBranch(context.Background(), runner, workspace, "feat/my-change", CheckoutGrantResponse{
		CloneURL: "https://github.com/acme/api.git", Token: token,
		ExpiresAt: time.Now().Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(runner.commands) != 1 || runner.credentialCalls != 1 {
		t.Fatalf("commands = %#v, credential calls = %d", runner.commands, runner.credentialCalls)
	}
	got := runner.commands[0]
	if got[0] != "push" || got[len(got)-1] != "HEAD:refs/heads/feat/my-change" {
		t.Fatalf("push command = %#v", got)
	}
	for _, command := range runner.commands {
		if strings.Contains(strings.Join(command, "\x00"), token) {
			t.Fatal("installation token entered git argv")
		}
	}
	for _, body := range runner.askpassBodies {
		if strings.Contains(body, token) {
			t.Fatal("installation token was written into askpass")
		}
	}
}

func TestPushBranchRequiresABranchName(t *testing.T) {
	workspace := filepath.Join(t.TempDir(), "repository")
	runner := &recordingGitRunner{}
	err := PushBranch(context.Background(), runner, workspace, "  ", CheckoutGrantResponse{
		CloneURL: "https://github.com/acme/api.git", Token: "token",
		ExpiresAt: time.Now().Add(time.Hour),
	})
	if err == nil || len(runner.commands) != 0 {
		t.Fatalf("error = %v, commands = %#v", err, runner.commands)
	}
}

func TestPushBranchRejectsAnExpiredGrant(t *testing.T) {
	workspace := filepath.Join(t.TempDir(), "repository")
	runner := &recordingGitRunner{}
	err := PushBranch(context.Background(), runner, workspace, "feat/my-change", CheckoutGrantResponse{
		CloneURL: "https://github.com/acme/api.git", Token: "token",
		ExpiresAt: time.Now().Add(-time.Minute),
	})
	if err == nil || len(runner.commands) != 0 {
		t.Fatalf("error = %v, commands = %#v, want a rejected expired grant with no push attempted", err, runner.commands)
	}
}

func TestExecGitRunnerRedactsCredentialFromErrors(t *testing.T) {
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "git"),
		[]byte("#!/bin/sh\nprintf '%s\\n' \"$AO_GIT_TOKEN\" >&2\nexit 1\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory)
	token := "credential-that-must-not-leak"
	_, err := (ExecGitRunner{}).Run(context.Background(), directory,
		map[string]string{"AO_GIT_TOKEN": token}, "fetch")
	if err == nil || strings.Contains(err.Error(), token) || !strings.Contains(err.Error(), "[REDACTED]") {
		t.Fatalf("error did not redact credential: %v", err)
	}
}
