package sandboxruntime

import (
	"reflect"
	"strings"
	"testing"
)

func exactLaunchArgv() []string {
	return []string{
		"--listen", "0.0.0.0:8080",
		"--control-plane-url", "https://control.example.test",
		"--sandbox-id", "runtime-row-1",
		"--workspace-id", "workspace-1",
		"--session-id", "session-1",
		"--workspace", "/workspace",
		"--ready-file", "/run/ao/ready.json",
		"--secret-dir", "/run/ao/secrets",
		"--route-prefix", "/api/sandbox/v1",
		"--", "/usr/local/bin/agent", "--prompt", "hello world",
	}
}

func TestParseLaunchConfigMatchesProviderContract(t *testing.T) {
	config, err := ParseLaunchConfig(exactLaunchArgv())
	if err != nil {
		t.Fatal(err)
	}
	if config.ListenAddress != DefaultListenAddress || config.ControlPlaneURL != "https://control.example.test" ||
		config.SandboxID != "runtime-row-1" || config.WorkspaceID != "workspace-1" || config.SessionID != "session-1" ||
		config.WorkspacePath != DefaultWorkspacePath || config.ReadyFile != DefaultReadyPath ||
		config.SecretDir != DefaultSecretDir || config.RoutePrefix != DefaultRoutePrefix {
		t.Fatalf("config = %#v", config)
	}
	wantChild := []string{"/usr/local/bin/agent", "--prompt", "hello world"}
	if !reflect.DeepEqual(config.ChildArgv, wantChild) {
		t.Fatalf("child argv = %#v", config.ChildArgv)
	}
}

func TestParseLaunchConfigHasNoCapabilityArgument(t *testing.T) {
	args := append([]string{"--capability", "must-not-be-in-argv"}, exactLaunchArgv()...)
	_, err := ParseLaunchConfig(args)
	if err == nil || strings.Contains(err.Error(), "must-not-be-in-argv") {
		t.Fatalf("error = %v", err)
	}
}

func TestParseLaunchConfigRejectsUnverifiedOrDriftingContract(t *testing.T) {
	for _, mutate := range []func([]string){
		func(args []string) { args[3] = "http://control.example.test" },
		func(args []string) { args[1] = "127.0.0.1:8080" },
		func(args []string) { args[11] = "/tmp/ready" },
		func(args []string) { args[15] = "/different" },
		func(args []string) { args[len(args)-3] = "agent" },
	} {
		args := exactLaunchArgv()
		mutate(args)
		if _, err := ParseLaunchConfig(args); err == nil {
			t.Errorf("mutated argv accepted: %#v", args)
		}
	}
}
