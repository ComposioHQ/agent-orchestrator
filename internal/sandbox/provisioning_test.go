package sandbox

import (
	"encoding/json"
	"testing"
	"time"
)

func TestDockerSessionPlanDoesNotConfigureAutoPause(t *testing.T) {
	plan, err := (ProvisioningDefaults{
		Provider: ProviderDocker,
		Release:  "local",
		Docker: DockerConfig{
			Host:           "unix:///var/run/docker.sock",
			WorkerImage:    "ao-cloud-worker:local",
			Network:        "ao-cloud-local_default",
			Namespace:      "ao-cloud-local",
			WorkerTokenTTL: 15 * time.Minute,
		},
	}).SessionPlan()
	if err != nil {
		t.Fatal(err)
	}
	var profile map[string]any
	if err := json.Unmarshal(plan.ResourceProfile, &profile); err != nil {
		t.Fatal(err)
	}
	if _, ok := profile["autoStopMinutes"]; ok {
		t.Errorf("resource profile configures autoStopMinutes: %#v", profile["autoStopMinutes"])
	}
	dockerProfile, ok := profile["docker"].(map[string]any)
	if !ok || dockerProfile["workerImage"] != "ao-cloud-worker:local" {
		t.Errorf("docker resource profile = %#v", profile["docker"])
	}
}

func TestNodeOpsSessionPlanDoesNotConfigureAutoPause(t *testing.T) {
	plan, err := (ProvisioningDefaults{
		Provider: ProviderNodeOps,
		NodeOps: NodeOpsConfig{
			BaseURL:        "https://nodeops.example",
			APIKey:         "secret",
			DefaultShape:   "shape",
			DefaultRootFS:  "rootfs",
			WorkerTokenTTL: 15 * time.Minute,
		},
	}).SessionPlan()
	if err != nil {
		t.Fatal(err)
	}
	var profile map[string]any
	if err := json.Unmarshal(plan.ResourceProfile, &profile); err != nil {
		t.Fatal(err)
	}
	if _, ok := profile["autoStopMinutes"]; ok {
		t.Errorf("resource profile configures autoStopMinutes: %#v", profile["autoStopMinutes"])
	}
}
