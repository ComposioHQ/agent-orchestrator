package sandbox

import (
	"encoding/json"
	"testing"
	"time"
)

func TestDockerSessionPlanHasNoAutoStop(t *testing.T) {
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
	if plan.AutoStopMinutes != 0 {
		t.Errorf("AutoStopMinutes = %d, want 0 for Docker", plan.AutoStopMinutes)
	}
	var profile map[string]any
	if err := json.Unmarshal(plan.ResourceProfile, &profile); err != nil {
		t.Fatal(err)
	}
	if profile["autoStopMinutes"] != float64(0) {
		t.Errorf("resource profile autoStopMinutes = %#v, want 0", profile["autoStopMinutes"])
	}
	dockerProfile, ok := profile["docker"].(map[string]any)
	if !ok || dockerProfile["workerImage"] != "ao-cloud-worker:local" {
		t.Errorf("docker resource profile = %#v", profile["docker"])
	}
}

func TestNodeOpsSessionPlanKeepsAutoPause(t *testing.T) {
	plan, err := (ProvisioningDefaults{
		Provider: ProviderNodeOps,
		NodeOps: NodeOpsConfig{
			BaseURL:          "https://nodeops.example",
			APIKey:           "secret",
			DefaultShape:     "shape",
			DefaultRootFS:    "rootfs",
			AutoPauseMinutes: 45,
			WorkerTokenTTL:   15 * time.Minute,
		},
	}).SessionPlan()
	if err != nil {
		t.Fatal(err)
	}
	if plan.AutoStopMinutes != 45 {
		t.Errorf("AutoStopMinutes = %d, want 45", plan.AutoStopMinutes)
	}
}
