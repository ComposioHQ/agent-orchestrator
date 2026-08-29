package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestCodexProfileSwitchFingerprintIncludesAcknowledgement(t *testing.T) {
	base := ComputeCodexProfileSwitchRequestFingerprint("ao-1", "profile-b", false)
	if !base.Valid() {
		t.Fatalf("fingerprint %q is invalid", base)
	}
	if base == ComputeCodexProfileSwitchRequestFingerprint("ao-1", "profile-c", false) {
		t.Fatal("target profile did not change fingerprint")
	}
	if base == ComputeCodexProfileSwitchRequestFingerprint("ao-1", "profile-b", true) {
		t.Fatal("capacity acknowledgement did not change fingerprint")
	}
}

func TestCodexProfileSwitchTransitionContract(t *testing.T) {
	valid := [][2]CodexProfileSwitchPhase{
		{CodexProfileSwitchRequested, CodexProfileSwitchWaitingForSafeBoundary},
		{CodexProfileSwitchWaitingForSafeBoundary, CodexProfileSwitchPreparingHandoff},
		{CodexProfileSwitchPreparingHandoff, CodexProfileSwitchStoppingSource},
		{CodexProfileSwitchStoppingSource, CodexProfileSwitchSourceStopped},
		{CodexProfileSwitchSourceStopped, CodexProfileSwitchStartingTarget},
		{CodexProfileSwitchStartingTarget, CodexProfileSwitchTargetReady},
		{CodexProfileSwitchTargetReady, CodexProfileSwitchDeliveringHandoff},
		{CodexProfileSwitchDeliveringHandoff, CodexProfileSwitchCompleted},
	}
	for _, transition := range valid {
		if !ValidCodexProfileSwitchTransition(transition[0], transition[1]) {
			t.Errorf("expected %s -> %s to be valid", transition[0], transition[1])
		}
	}
	if ValidCodexProfileSwitchTransition(CodexProfileSwitchStoppingSource, CodexProfileSwitchCancelled) {
		t.Fatal("cancellation remained possible after source shutdown began")
	}
	if ValidCodexProfileSwitchTransition(CodexProfileSwitchCompleted, CodexProfileSwitchStartingTarget) {
		t.Fatal("terminal operation resumed")
	}
}

func TestCodexProfileSwitchJSONRedactsPrivateCoordinatorState(t *testing.T) {
	body, err := json.Marshal(CodexProfileSwitch{
		ID: "switch-1", SourceSessionID: "ao-1", SourceProfileID: "existing", TargetProfileID: "managed-1",
		IdempotencyKey: "private-retry-key", RequestFingerprint: "v1:private",
		WorkspaceOwner: CodexProfileSwitchOwnerRecovery, SourceGenerationID: "source-generation",
		TargetGenerationID: "target-generation", TargetRuntimeHandleID: "runtime-handle",
		TargetControllerGeneration: "controller-generation", TargetProviderThreadID: "provider-thread",
		FinalHandoffPath: "/private/handoff.json", FinalHandoffHash: strings.Repeat("a", 64),
	})
	if err != nil {
		t.Fatal(err)
	}
	encoded := string(body)
	for _, secret := range []string{"private-retry-key", "v1:private", "recovery", "source-generation", "target-generation", "runtime-handle", "controller-generation", "provider-thread", "/private/handoff.json", strings.Repeat("a", 64)} {
		if strings.Contains(encoded, secret) {
			t.Fatalf("private coordinator state %q leaked in %s", secret, encoded)
		}
	}
}
