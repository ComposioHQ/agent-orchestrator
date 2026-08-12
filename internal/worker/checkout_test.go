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
	_ context.Context, _ string, environment map[string]string, arguments ...string,
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
