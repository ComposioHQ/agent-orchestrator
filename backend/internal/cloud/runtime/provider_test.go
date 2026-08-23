package runtime_test

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/runtime"
)

func validCreateRequest() runtime.CreateRequest {
	ref := workerRef()
	return runtime.CreateRequest{
		Ref:                   ref,
		Labels:                runtime.Labels("staging", ref, "rt-1"),
		Snapshot:              "ao-worker",
		CapabilityFilePath:    runtime.CapabilityFilePath,
		ControlPlaneRedeemURL: "https://cloud.example/api/internal/sandbox-tickets/redeem",
		Env:                   map[string]string{},
		Command:               "/bin/sh",
		Args:                  []string{"-l"},
	}
}

func TestCreateRequestRejectsSecretsOnTheCommandLine(t *testing.T) {
	request := validCreateRequest()
	request.SecretFiles = []runtime.FileSecret{{Path: "/run/secrets/gh", Content: []byte("ghs_thisIsALongLivedToken"), Mode: 0o600}}
	request.Command = "/usr/bin/ao-agent"
	request.Args = []string{"--token", "ghs_thisIsALongLivedToken"}

	err := request.Validate()
	if !errors.Is(err, runtime.ErrInvalid) {
		t.Fatalf("err = %v, want ErrInvalid", err)
	}
	if !strings.Contains(err.Error(), "/run/secrets/gh") {
		t.Fatalf("error = %q, want leaked file named", err.Error())
	}
}

func TestCreateRequestAllowsShortNonSecretValuesInArguments(t *testing.T) {
	// A short env value like "1" or "true" appears in ordinary flags; matching
	// it would make the guard unusable without protecting anything.
	request := validCreateRequest()
	request.Env["AO_DEBUG"] = "1"
	request.Command = "/usr/bin/ao-agent"
	request.Args = []string{"--verbosity", "1"}
	if err := request.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestCreateRequestRejectsSecretBearingEnvironment(t *testing.T) {
	request := validCreateRequest()
	request.Env["GITHUB_TOKEN"] = "secret-value"
	if err := request.Validate(); !errors.Is(err, runtime.ErrInvalid) {
		t.Fatalf("err = %v, want ErrInvalid", err)
	}
	request = validCreateRequest()
	request.Env["GITHUB_TOKEN_FILE"] = "/run/ao/github-token"
	if err := request.Validate(); err != nil {
		t.Fatalf("non-secret file path rejected: %v", err)
	}
}

func TestCreateRequestRequiresAttributableLabelsAndASnapshot(t *testing.T) {
	noSnapshot := validCreateRequest()
	noSnapshot.Snapshot = "  "
	if err := noSnapshot.Validate(); !errors.Is(err, runtime.ErrInvalid) {
		t.Fatalf("err = %v", err)
	}
	unlabelled := validCreateRequest()
	delete(unlabelled.Labels, runtime.LabelSession)
	if err := unlabelled.Validate(); !errors.Is(err, runtime.ErrInvalid) {
		t.Fatalf("err = %v", err)
	}
	incomplete := validCreateRequest()
	incomplete.Ref.UserID = ""
	if err := incomplete.Validate(); !errors.Is(err, runtime.ErrInvalid) {
		t.Fatalf("err = %v", err)
	}
}

func TestAttributeRejectsPartialAndForeignLabels(t *testing.T) {
	ref := workerRef()
	complete := runtime.Labels("staging", ref, "rt-1")
	if _, ok := runtime.Attribute(complete); !ok {
		t.Fatal("complete label set rejected")
	}
	for name, mutate := range map[string]func(map[string]string){
		"missing runtime":  func(labels map[string]string) { delete(labels, runtime.LabelRuntimeID) },
		"blank org":        func(labels map[string]string) { labels[runtime.LabelOrg] = "  " },
		"unmanaged":        func(labels map[string]string) { labels[runtime.LabelManaged] = "false" },
		"unknown role":     func(labels map[string]string) { labels[runtime.LabelRole] = "admin" },
		"missing deployer": func(labels map[string]string) { delete(labels, runtime.LabelDeployment) },
	} {
		labels := runtime.Labels("staging", ref, "rt-1")
		mutate(labels)
		if _, ok := runtime.Attribute(labels); ok {
			t.Fatalf("%s: accepted as attributable", name)
		}
	}
	if _, ok := runtime.Attribute(nil); ok {
		t.Fatal("an unlabelled sandbox must never be attributable")
	}
}

func TestFilterMatchesFallsBackToCreationWhenNoHeartbeatArrived(t *testing.T) {
	created := time.Date(2026, 8, 22, 9, 0, 0, 0, time.UTC)
	never := runtime.Record{OrgID: "org-1", WorkspaceID: "ws-1", SessionID: "s", CreatedAt: created, State: runtime.StateRunning}
	beat := never
	beat.LastHeartbeatAt = created.Add(time.Hour)

	filter := runtime.Filter{HeartbeatBefore: created.Add(30 * time.Minute)}
	if !filter.Matches(never) {
		t.Fatal("a placement that never checked in must be reapable from its creation time")
	}
	if filter.Matches(beat) {
		t.Fatal("a recent heartbeat must protect the placement")
	}
}

func TestFilterExcludesTerminalPlacements(t *testing.T) {
	deleting := runtime.Record{OrgID: "org-1", State: runtime.StateDeleting}
	if (runtime.Filter{OrgID: "org-1", ExcludeTerminal: true}).Matches(deleting) {
		t.Fatal("a placement being deleted must not be counted")
	}
	if !(runtime.Filter{OrgID: "org-1"}).Matches(deleting) {
		t.Fatal("a plain filter must still see it")
	}
}
